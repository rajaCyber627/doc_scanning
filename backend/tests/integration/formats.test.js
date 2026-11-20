const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { PDFDocument } = require('pdf-lib');
const request = require('supertest');
const { startDb, clearDb, stopDb } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
const FX = path.join(__dirname, '../support/fixtures/formats');
const fx = (n) => fs.readFileSync(path.join(FX, n));
let user;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  user = await User.create({ email: 'hr@example.com', userName: 'hr', password: 'x' });
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await onIdle();
    await events.idle();
  }
};

/** Upload through the real session flow (type checks + content sniffing). */
async function upload(name, buf) {
  const c = await request(app).post('/api/uploads').send({ userId: String(user._id), fileName: name, sizeBytes: buf.length });
  if (c.status !== 201) return { status: c.status, body: c.body };
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: String(user._id) });
  if (done.status !== 201) return { status: done.status, body: done.body };
  await settle();
  return { status: 201, file: await File.findById(done.body.file._id) };
}

const isPdf = (buf) => buf && buf.subarray(0, 5).toString() === '%PDF-';
const pages = async (buf) => (await PDFDocument.load(buf)).getPageCount();

describe('office and text formats → text + PDF view', () => {
  test.each([
    ['personnel-action.doc', ['Maria Lopez', 'Employee ID: 2210', 'Promotion to Supervisor']],
    ['notice.rtf', ['Disciplinary Notice', 'André Dubois', 'Issued — see policy HR-7', '\tStatus: Final']],
    ['certificate.odt', ['Training Certificate', 'Kim Nguyen & team\tID 7781', 'Workplace Safety']],
    ['roster.xlsx', ['Sheet: Roster', 'John Smith,1045,52000', 'Priya Patel,2087,72500']],
    ['roster.xls', ['Sheet: Roster', 'John Smith,1045,52000']],
  ])('%s', async (name, expected) => {
    const { file } = await upload(name, fx(name));
    expect(file.status).toBe('ready');
    for (const e of expected) expect(file.rawText).toContain(e);
    expect(file.renditionS3Key).toBe(`${file.s3Key}.view.pdf`);
    expect(file.renditionMethod).toBe('text'); // no LibreOffice in tests
    expect(isPdf(fakes.__objects.get(file.renditionS3Key))).toBe(true);
    expect(fakes.__objects.get(file.s3Key).equals(fx(name))).toBe(true); // original untouched
  });

  test('RTF: font tables, generator and field instructions are not shown as text', async () => {
    const { file } = await upload('notice.rtf', fx('notice.rtf'));
    expect(file.rawText).not.toMatch(/Times New Roman|HYPERLINK|Test;|red0/);
  });

  test('PowerPoint: slides in numeric order (1, 2, 10) and the slide count', async () => {
    const { file } = await upload('orientation.pptx', fx('orientation.pptx'));
    expect(file.rawText.indexOf('Slide 1')).toBeLessThan(file.rawText.indexOf('Slide 2'));
    expect(file.rawText.indexOf('Slide 2')).toBeLessThan(file.rawText.indexOf('Slide 10'));
    expect(file.rawText).toContain('Open enrollment: Nov 1 & Nov 30');
    expect(file.pageCount).toBe(3);
  });

  test('spreadsheets also fill the tables used for Q&A, and formulas stay text', async () => {
    const { file } = await upload('roster.xlsx', fx('roster.xlsx'));
    const f = await File.findById(file._id).select('tablesCsv');
    expect(f.tablesCsv).toContain('Table 1 (Roster)');
    expect(file.rawText).toContain('=cmd not a formula');
  });

  test('the PDF view is served by GET /api/files/:id/rendition', async () => {
    const { file } = await upload('certificate.odt', fx('certificate.odt'));
    const res = await request(app).get(`/api/files/${file._id}/rendition`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(isPdf(res.body)).toBe(true);
  });
});

describe('images', () => {
  test.each(['photo.heic', 'scan.gif', 'scan.bmp'])('%s is converted to JPEG for OCR and display', async (name) => {
    fakes.__textract.mode = 'ok';
    const { file } = await upload(name, fx(name));
    expect(file.status).toBe('ready');
    expect(file.ocrSourceS3Key).toBe(`${file.s3Key}.converted.jpg`);
    const jpg = fakes.__objects.get(file.ocrSourceS3Key);
    expect(jpg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    expect(fakes.__textract.calls).toEqual([file.ocrSourceS3Key]); // OCR read the JPEG, not the original
    expect(file.rawText).toContain('OCR text of');
    expect(await pages(fakes.__objects.get(file.renditionS3Key))).toBe(1);

    const detail = await request(app).get(`/api/files/${file._id}`);
    expect(detail.body.viewUrl).toContain('.converted.jpg');
    expect(detail.body.downloadUrl).not.toContain('.converted.jpg');
  });

  test('a two-page TIFF gets a two-page PDF view', async () => {
    fakes.__textract.mode = 'ok';
    const { file } = await upload('two-pages.tif', fx('two-pages.tif'));
    expect(file.status).toBe('ready');
    expect(await pages(fakes.__objects.get(file.renditionS3Key))).toBe(2);
  });

  test('when Textract is not activated the reason is clear (conversion still happened)', async () => {
    const { file } = await upload('photo.heic', fx('photo.heic'));
    expect(file.status).toBe('failed');
    expect(file.errorCode).toBe('OCR_NOT_ACTIVATED');
    expect(file.ocrSourceS3Key).toBe(`${file.s3Key}.converted.jpg`); // tracked, so it can be shown and cleaned up
    expect(fakes.__objects.has(file.ocrSourceS3Key)).toBe(true);
    await request(app).delete(`/api/files/${file._id}`);
    expect(fakes.__objects.has(file.ocrSourceS3Key)).toBe(false);
  });
});

describe('emails become linked documents', () => {
  test('.eml: body is the document, real attachments become children, inline logo and programs are not imported', async () => {
    const { file } = await upload('intake.eml', fx('intake.eml'));
    expect(file.status).toBe('ready');
    expect(file.rawText).toContain('Subject: Doctor note and W-4 for John Smith (ID 1045)');
    expect(file.rawText).toContain('From: Maria Lopez <mlopez@example.gov>');
    expect(file.rawText).toContain('Attached are the doctor note and W-4.');
    expect(file.metadata.email.subject).toContain('Doctor note');
    expect(file.childSummary.created).toBe(2);
    expect(file.childSummary.skipped).toEqual([{ name: 'invoice.exe', reason: 'Programs and scripts are never imported' }]);

    const kids = await File.find({ parentDocumentId: file._id }).sort({ s3Key: 1 });
    expect(kids.map((k) => k.fileName)).toEqual(['doctor-note.txt', 'w4.pdf']);
    expect(kids.every((k) => k.status === 'ready')).toBe(true);
    expect(kids[0].rawText).toContain('may return to work');
    expect(kids[1].rawText).toContain('Carlos Rivera');

    const detail = await request(app).get(`/api/files/${file._id}`);
    expect(detail.body.children.map((c) => c.fileName)).toEqual(['doctor-note.txt', 'w4.pdf']);
    const child = await request(app).get(`/api/files/${kids[0]._id}`);
    expect(child.body.parent.fileName).toBe('intake.eml');
  });

  test('.msg with 2 attachments produces 3 linked documents', async () => {
    const { file } = await upload('return-to-work.msg', fx('return-to-work.msg'));
    expect(file.status).toBe('ready');
    expect(file.rawText).toContain('Subject: Return to work - John Smith (ID 1045)');
    expect(file.rawText).toContain('From: Dr. Alice Reed <areed@clinic.example>');
    expect(file.rawText).toContain('To: HR Intake <hr-intake@example.gov>');
    const kids = await File.find({ parentDocumentId: file._id }).sort({ s3Key: 1 });
    expect(kids.map((k) => [k.fileName, k.status])).toEqual([
      ['certification.txt', 'ready'],
      ['w4.pdf', 'ready'],
    ]);
    expect(await File.countDocuments()).toBe(3);
  });
});

describe('ZIP archives', () => {
  test('each file inside becomes a document; programs skipped; OS clutter ignored; one nested zip expanded', async () => {
    const { file } = await upload('personnel-files.zip', fx('personnel-files.zip'));
    expect(file.status).toBe('ready');
    expect(file.rawText).toMatch(/Archive contents \(\d+ files\)/);
    expect(file.childSummary.skipped).toEqual([{ name: 'setup.exe', reason: 'Programs and scripts are never imported' }]);
    const names = (await File.find({ _id: { $ne: file._id } })).map((f) => f.fileName).sort();
    expect(names).toEqual(['evaluation.txt', 'inner-note.txt', 'inner.zip', 'w4.pdf']);
    const ev = await File.findOne({ fileName: 'evaluation.txt' });
    expect(ev.metadata.sourcePath).toBe('HR/Smith_John_1045/evaluation.txt');
    expect(ev.parentDocumentId.equals(file._id)).toBe(true);
    const innerNote = await File.findOne({ fileName: 'inner-note.txt' });
    expect(innerNote.containerDepth).toBe(2);
  });

  test('zip bomb protections: too many files, and extreme compression', async () => {
    const many = new JSZip();
    for (let i = 0; i < 60; i++) many.file(`f${i}.txt`, 'x');
    const r1 = await upload('many.zip', await many.generateAsync({ type: 'nodebuffer' }));
    expect(r1.file.status).toBe('failed');
    expect(r1.file.errorCode).toBe('ARCHIVE_TOO_LARGE');

    const bomb = new JSZip();
    bomb.file('zeros.txt', Buffer.alloc(12 * 1024 * 1024));
    const r2 = await upload('bomb.zip', await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    expect(r2.file.status).toBe('failed');
    expect(r2.file.errorCode).toBe('ARCHIVE_SUSPICIOUS');
    expect(await File.countDocuments({ parentDocumentId: { $ne: null } })).toBe(0);
  });

  test('password-protected entries are skipped with a reason', async () => {
    const z = new JSZip();
    z.file('open.txt', 'readable');
    z.file('secret.txt', 'hidden text that is compressed');
    // deflated, like real encrypted entries (stored ones carry a 12-byte encryption header)
    const buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    // mark secret.txt as encrypted (general purpose flag bit 0) in both headers
    const name = Buffer.from('secret.txt');
    for (const [sig, flagOffset, nameOffset] of [[0x04034b50, 6, 30], [0x02014b50, 8, 46]]) {
      for (let i = 0; i < buf.length - 4; i++) {
        if (buf.readUInt32LE(i) === sig && buf.subarray(i + nameOffset, i + nameOffset + name.length).equals(name)) {
          buf.writeUInt16LE(buf.readUInt16LE(i + flagOffset) | 1, i + flagOffset);
        }
      }
    }
    const { file } = await upload('mixed.zip', buf);
    expect(file.status).toBe('ready');
    expect(file.childSummary.skipped).toEqual([{ name: 'secret.txt', reason: 'Password-protected inside the archive' }]);
    expect((await File.find({ parentDocumentId: file._id })).map((f) => f.fileName)).toEqual(['open.txt']);
  });
});

describe('safety and clear failures', () => {
  test('an encrypted Office file is reported as password-protected at upload', async () => {
    const r = await upload('salary.docx', fx('personnel-action.doc')); // OLE container, as encrypted .docx files are
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/password-protected/);
  });

  test('unsupported files fail before upload with the accepted list', async () => {
    const r = await upload('macro.xlsm', Buffer.from('x'));
    expect(r.status).toBe(415);
    expect(r.body.message).toMatch(/Accepted: .*\.msg/);
  });

  test('deleting a document removes its PDF view and converted image too', async () => {
    fakes.__textract.mode = 'ok';
    const { file } = await upload('scan.gif', fx('scan.gif'));
    await request(app).delete(`/api/files/${file._id}`);
    for (const k of [file.s3Key, file.renditionS3Key, file.ocrSourceS3Key]) expect(fakes.__objects.has(k)).toBe(false);
  });
});
