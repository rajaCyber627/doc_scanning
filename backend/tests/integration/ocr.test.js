const fs = require('fs');
const path = require('path');
const os = require('os');
const Jimp = require('jimp');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const config = require('../../src/core/config');
const { buildBlocks } = require('../../src/providers/ocr/buildBlocks');
const fixtureProvider = require('../../src/providers/ocr/fixture');
const { exifOrientation } = require('../../src/features/ocr/preprocess');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const OcrPage = require('../../src/features/ocr/OcrPage.model');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
let user;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  fakes.__textract.mode = 'ok';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  user = await User.create({ email: 'hr@example.com', userName: 'hr', password: 'x' });
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await onIdle();
    await events.idle();
  }
};

async function upload(name, buf) {
  const c = await request(app).post('/api/uploads').send({ userId: String(user._id), fileName: name, sizeBytes: buf.length });
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: String(user._id) });
  expect(done.status).toBe(201);
  await settle();
  return File.findById(done.body.file._id);
}

async function scannedPdf(pages) {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(fs.readFileSync(fixture('w4_scan.png')));
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
  return Buffer.from(await doc.save());
}

const W4_PAGES = [
  {
    lines: [{ text: 'Form W-4 (2025) Employee Withholding Certificate' }, { text: 'Employee: Carlos Rivera' }, { text: 'Employee ID: 3310' }],
    keyValues: [['Employee ID:', '3310'], ['Filing status', 'Married filing jointly']],
  },
  { lines: [{ text: 'Dependents: 2' }, { text: 'Extra withholding: $50 per pay period' }, { text: 'Page two of the form' }], tables: [[['Name', 'Amount'], ['Child credit', '$4,000']]] },
  { lines: [{ text: 'Signed January 15 2025 by the employee' }, { text: 'Payroll office copy' }, { text: 'Retain for four years' }] },
];

describe('scanned PDFs', () => {
  test('3-page scan → per-page text, confidence, form fields, tables; searchable PDF; highlight boxes', async () => {
    fakes.__textract.results.set('default', buildBlocks(W4_PAGES));
    const f = await upload('w4-scan.pdf', await scannedPdf(3));
    expect(f.status).toBe('ready');
    expect(f.pageCount).toBe(3);
    expect(f.rawText).toContain('Employee: Carlos Rivera');
    expect(f.rawText).toContain('Retain for four years');
    expect(f.ocr).toMatchObject({ provider: 'textract', mode: 'analysis', pages: 3, avgConfidence: 99 });
    expect(f.ocr.keyValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'Employee ID', value: '3310', page: 1 }),
        expect.objectContaining({ key: 'Filing status', value: 'Married filing jointly' }),
      ])
    );
    expect(fakes.__textract.features[0]).toEqual(['TABLES', 'FORMS']);
    const stored = await File.findById(f._id).select('tablesCsv words');
    expect(stored.tablesCsv).toContain('Table 1 (page 2)');
    expect(stored.tablesCsv).toContain('"Child credit","$4,000"');
    expect(stored.words).toEqual([]); // no longer stored on the File

    const pages = await OcrPage.find({ fileId: f._id }).sort({ page: 1 });
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages[0].confidence).toBe(99);
    expect(pages[1].tables[0].rows[1]).toEqual(['Child credit', '$4,000']);

    // searchable PDF: same 3 pages, and the OCR text can be found in it
    expect(f.renditionMethod).toBe('ocr');
    const view = fakes.__objects.get(f.renditionS3Key);
    expect((await PDFDocument.load(view)).getPageCount()).toBe(3);
    expect((await pdfParse(view)).text).toContain('Carlos');

    const geo = await request(app).get(`/api/files/${f._id}/geometry`);
    expect(geo.body.words.find((w) => w.text === 'Carlos')).toMatchObject({ page: 1, x: expect.any(Number), w: expect.any(Number) });
    const p2 = await request(app).get(`/api/files/${f._id}/geometry?page=2`);
    expect(p2.body.words.every((w) => w.page === 2)).toBe(true);
  });

  test('digital PDFs still skip OCR entirely', async () => {
    const f = await upload('w4_typed.pdf', fs.readFileSync(fixture('w4_typed.pdf')));
    expect(f.status).toBe('ready');
    expect(fakes.__textract.calls).toEqual([]);
    expect(f.renditionS3Key).toBeNull();
  });

  test('if the account may not use form analysis, plain text detection is used', async () => {
    fakes.__textract.denyAnalysis = true;
    const f = await upload('scan.png', fs.readFileSync(fixture('w4_scan.png')));
    expect(f.status).toBe('ready');
    expect(f.ocr.mode).toBe('text');
  });

  test('no word limit: a 9,000-word page keeps every word box', async () => {
    const line = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
    fakes.__textract.results.set('default', buildBlocks([{ lines: Array.from({ length: 90 }, () => ({ text: line })) }]));
    const f = await upload('dense.png', fs.readFileSync(fixture('w4_scan.png')));
    const page = await OcrPage.findOne({ fileId: f._id });
    expect(page.words).toHaveLength(9000);
  });
});

describe('quality checks → needs review', () => {
  test.each([
    ['low confidence', [{ lines: [{ text: 'faint text here', conf: 55 }, { text: 'more faint text', conf: 60 }] }], 'LOW_CONFIDENCE', /hard to read \(58% confidence\)/],
    ['blank page', [{ lines: [] }], 'BLANK_PAGE', /no readable text/],
    ['handwriting', [{ lines: [{ text: 'signed by hand today', handwriting: true }, { text: 'printed line here' }] }], 'HANDWRITING', /mostly handwritten/],
  ])('%s', async (_, pages, code, message) => {
    fakes.__textract.results.set('default', buildBlocks(pages));
    const f = await upload('scan.png', fs.readFileSync(fixture('w4_scan.png')));
    expect(f.status).toBe('needs_review');
    expect(f.reviewReasons[0]).toMatchObject({ code, stage: 'ocr' });
    expect(f.reviewReasons[0].message).toMatch(message);
    expect(await AuditEvent.countDocuments({ action: 'document.needs_review', documentId: f._id })).toBe(1);
  });

  test('a reviewer accepts the document: ready, reasons kept as history, audited', async () => {
    fakes.__textract.results.set('default', buildBlocks([{ lines: [{ text: 'faint text here', conf: 50 }, { text: 'more', conf: 50 }, { text: 'x y z', conf: 50 }] }]));
    const f = await upload('scan.png', fs.readFileSync(fixture('w4_scan.png')));
    const res = await request(app).post(`/api/files/${f._id}/review`).send({ userId: String(user._id), note: 'Checked against paper' });
    expect(res.status).toBe(200);
    const after = await File.findById(f._id);
    expect(after.status).toBe('ready');
    expect(after.reviewReasons).toEqual([]);
    expect(after.resolvedReviewReasons[0]).toMatchObject({ code: 'LOW_CONFIDENCE' });
    expect(after.reviewedBy.equals(user._id)).toBe(true);
    const ev = await AuditEvent.findOne({ action: 'document.reviewed' });
    expect(ev.details).toMatchObject({ reasons: ['LOW_CONFIDENCE'], note: 'Checked against paper' });
    expect((await request(app).post(`/api/files/${f._id}/review`).send({})).status).toBe(409);
  });

  test('a multi-page scan at an angle is flagged (pages are not re-scanned)', async () => {
    const tilted = { lines: [{ text: 'tilted line one', angle: 7 }, { text: 'tilted line two', angle: 7 }, { text: 'and three', angle: 7 }] };
    fakes.__textract.results.set('default', buildBlocks([tilted, tilted]));
    const f = await upload('tilted.pdf', await scannedPdf(2));
    expect(f.status).toBe('needs_review');
    expect(f.reviewReasons.map((r) => r.code)).toEqual(['SKEWED', 'SKEWED']);
    expect(f.reviewReasons[0].message).toMatch(/^Page 1: scanned at an angle \(7°\)/);
  });
});

describe('image clean-up before OCR', () => {
  test('a tilted photo is straightened and read again; the straight version is kept', async () => {
    const tilted = buildBlocks([{ lines: [{ text: 'Employee: Kim Lee', angle: 8 }, { text: 'ID 7781 badge', angle: 8 }, { text: 'Dept Safety', angle: 8 }] }]);
    const straight = buildBlocks([{ lines: [{ text: 'Employee: Kim Lee' }, { text: 'ID 7781 badge' }, { text: 'Dept Safety' }] }]);
    fakes.__textract.byCall.push(tilted, straight);
    const f = await upload('badge.png', fs.readFileSync(fixture('w4_scan.png')));
    expect(fakes.__textract.calls).toHaveLength(2);
    expect(fakes.__textract.calls[1]).toBe(`${f.s3Key}.converted.jpg`);
    expect(f.status).toBe('ready'); // no "skewed" reason once corrected
    expect(f.ocr.corrected).toBe(true);
    expect(f.ocrSourceS3Key).toBe(`${f.s3Key}.converted.jpg`);
    expect(fakes.__objects.get(f.s3Key).equals(fs.readFileSync(fixture('w4_scan.png')))).toBe(true); // original untouched
  });

  test('a sideways phone photo (EXIF orientation 6) is turned upright before OCR', async () => {
    const img = await Jimp.read(fixture('w4_scan.png'));
    img.resize(300, 200);
    const jpg = await img.getBufferAsync(Jimp.MIME_JPEG);
    // insert an EXIF APP1 segment with Orientation = 6 (rotate 90° clockwise)
    const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const withExif = Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
    expect(exifOrientation(withExif)).toBe(6);

    const f = await upload('phone.jpg', withExif);
    expect(f.status).toBe('ready');
    expect(fakes.__textract.calls[0]).toBe(`${f.s3Key}.converted.jpg`);
    const upright = await Jimp.read(fakes.__objects.get(f.ocrSourceS3Key));
    expect([upright.bitmap.width, upright.bitmap.height]).toEqual([200, 300]); // rotated
    expect(exifOrientation(fakes.__objects.get(f.ocrSourceS3Key))).toBe(1); // tag cleared: no double rotation
  });
});

describe('fixture provider (development while Textract is not activated)', () => {
  test('reads a saved Textract response by file name, then falls back to default.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fx-'));
    const prev = config.ocr.fixtureDir;
    config.ocr.fixtureDir = dir;
    try {
      fs.writeFileSync(path.join(dir, 'w4_scan.png.json'), JSON.stringify({ Blocks: buildBlocks(W4_PAGES.slice(0, 1)) }));
      const r = await fixtureProvider.analyze('some/key', { fileName: 'w4_scan.png' });
      expect(r.provider).toBe('fixture');
      expect(r.text).toContain('Carlos Rivera');
      await expect(fixtureProvider.analyze('k', { fileName: 'other.png' })).rejects.toThrow(/No saved OCR result/);
      fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify({ Blocks: buildBlocks([{ lines: [{ text: 'default' }] }]) }));
      expect((await fixtureProvider.analyze('k', { fileName: 'other.png' })).text).toBe('default');
    } finally {
      config.ocr.fixtureDir = prev;
    }
  });
});
