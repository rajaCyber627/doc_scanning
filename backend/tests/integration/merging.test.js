const request = require('supertest');
const Jimp = require('jimp');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { startDb, clearDb, stopDb } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const { buildBlocks } = require('../../src/providers/ocr/buildBlocks');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const SearchDoc = require('../../src/models/SearchDoc');
const OcrPage = require('../../src/features/ocr/OcrPage.model');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');
const { pdfPageTexts } = require('../../src/features/splitting/pages');

const app = createApp();
let user;
let admin;
let other; // staff member without restricted access who did not upload the document

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  fakes.__textract.mode = 'ok';
  jest.spyOn(console, 'error').mockImplementation(() => {});
  user = await User.create({ email: 'hr@example.com', userName: 'hr', password: 'x' });
  admin = await User.create({ email: 'admin@example.com', userName: 'admin', password: 'x', permissions: ['admin', 'restricted'] });
  other = await User.create({ email: 'other@example.com', userName: 'other', password: 'x' });
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await onIdle();
    await events.idle();
  }
};
const uid = () => String(user._id);

async function upload(name, buf, who = user) {
  const c = await request(app).post('/api/uploads').send({ userId: String(who._id), fileName: name, sizeBytes: buf.length });
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: String(who._id) });
  await settle();
  return File.findById(done.body.file._id);
}

/** A scanned page (PNG) whose OCR says `lines`. */
async function scan(name, lines, width) {
  fakes.__textract.byCall.push(buildBlocks([{ lines: lines.map((text) => ({ text })) }]));
  const png = await new Jimp(width, 1100, 0xffffffff).getBufferAsync(Jimp.MIME_PNG);
  return upload(name, png);
}

async function textPdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pages) {
    const page = doc.addPage([612, 792]);
    t.split('\n').forEach((line, i) => page.drawText(line, { x: 50, y: 740 - i * 16, size: 10, font }));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
const long = (s) => `${s} This page belongs to the City of Portsmouth personnel record and is signed by both parties.`;

const pagesOf = (...files) => files.map((f) => ({ fileId: String(f._id), page: 1 }));

describe('merging scans', () => {
  test('3 single-page scans → one 3-page document; find works across all pages; sources linked, not changed', async () => {
    const a = await scan('contract-p1.png', ['EMPLOYMENT CONTRACT', 'between the City and John Smith'], 850);
    const b = await scan('contract-p2.png', ['Section 2 compensation', 'salary paid biweekly'], 851);
    const c = await scan('contract-p3.png', ['Section 3 signatures', 'witnessed by Priya Patel'], 852);
    for (const f of [a, b, c]) expect(f.renditionS3Key).toBeTruthy(); // searchable PDF views
    const ocrCalls = fakes.__textract.calls.length;

    const pv = await request(app).post('/api/merge/preview').send({ userId: uid(), fileIds: [a._id, b._id, c._id] });
    expect(pv.status).toBe(200);
    expect(pv.body).toMatchObject({ conflicts: [], mixedRestricted: false });
    expect(pv.body.sources.map((s) => s.fileName)).toEqual(['contract-p1.png', 'contract-p2.png', 'contract-p3.png']);

    const r = await request(app).post('/api/merge').send({ userId: uid(), name: 'Smith employment contract', pages: pagesOf(a, b, c) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ fileName: 'Smith employment contract.pdf', pageCount: 3 });
    await settle();

    const m = await File.findById(r.body.fileId);
    expect(['ready', 'needs_review']).toContain(m.status);
    expect(m.derivedFrom.map(String)).toEqual([a, b, c].map((f) => String(f._id)));
    expect(m.rawText).toBe('EMPLOYMENT CONTRACT\nbetween the City and John Smith\n\nSection 2 compensation\nsalary paid biweekly\n\nSection 3 signatures\nwitnessed by Priya Patel');
    expect(m.duplicateOf).toEqual([]);
    expect(fakes.__textract.calls.length).toBe(ocrCalls); // nothing OCR'd again

    // word boxes remapped to the new page numbers → in-document find highlights every page
    const geo = (await request(app).get(`/api/files/${m._id}/geometry`)).body.words;
    expect(geo.find((w) => w.text === 'witnessed').page).toBe(3);
    expect(geo.find((w) => w.text === 'compensation').page).toBe(2);
    // the merged PDF keeps each page's searchable text layer
    const texts = await pdfPageTexts(fakes.__objects.get(m.s3Key));
    expect(texts).toHaveLength(3);
    expect(texts[2]).toMatch(/witnessed/);
    expect(m.renditionS3Key).toBeNull(); // no second text layer needed
    // full-text search finds the merged document by text from its last page
    const s = await request(app).get(`/api/search?userId=${uid()}&q=witnessed`);
    expect(s.body.results.map((x) => x.fileId)).toContain(String(m._id));

    // sources are untouched (not superseded unless asked)
    for (const f of [a, b, c]) expect((await File.findById(f._id)).supersededBy).toBeNull();
    const audit = await AuditEvent.findOne({ action: 'document.merged' }).lean();
    expect(audit.details).toMatchObject({ sources: [a, b, c].map((f) => String(f._id)), pages: pagesOf(a, b, c), supersede: false });
  });

  test('drag-to-reorder, rotate and leave out pages; optionally supersede the sources', async () => {
    const a = await upload('a.pdf', await textPdf([long('Alpha one.'), long('Alpha two.')]));
    const b = await upload('b.pdf', await textPdf([long('Beta one.')]));
    const r = await request(app)
      .post('/api/merge')
      .send({
        userId: uid(),
        supersede: true,
        pages: [
          { fileId: String(b._id), page: 1 },
          { fileId: String(a._id), page: 2, rotate: 90 },
        ],
      });
    expect(r.status).toBe(200);
    await settle();
    const m = await File.findById(r.body.fileId);
    expect(m.fileName).toBe('b (merged).pdf'); // named after the first page's document
    expect(m.mergeOf.pages).toEqual([
      { fileId: String(b._id), page: 1, rotate: 0 },
      { fileId: String(a._id), page: 2, rotate: 90 },
    ]);
    expect(m.rawText).toMatch(/^Beta one\..*\n\nAlpha two\./s);
    const out = await PDFDocument.load(fakes.__objects.get(m.s3Key));
    expect(out.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90]);
    // superseded sources: kept, hidden from the list and from search
    expect((await File.findById(a._id)).supersededBy.toString()).toBe(String(m._id));
    const list = (await request(app).get(`/api/files?userId=${uid()}`)).body.map((f) => f._id);
    expect(list).toContain(String(m._id));
    expect(list).not.toContain(String(a._id));
    expect(await SearchDoc.exists({ fileId: a._id })).toBeNull();
    expect(fakes.__objects.has(a.s3Key)).toBe(true);
  });

  test('a plan must be valid', async () => {
    const a = await upload('a.pdf', await textPdf([long('Alpha one.')]));
    const b = await upload('b.pdf', await textPdf([long('Beta one.')]));
    const post = (pages) => request(app).post('/api/merge').send({ userId: uid(), pages });
    expect((await post([{ fileId: String(a._id), page: 1 }])).status).toBe(400);
    expect((await post([{ fileId: String(a._id), page: 1 }, { fileId: String(a._id), page: 1 }])).body.message).toMatch(/at least two documents/);
    expect((await post([{ fileId: String(a._id), page: 1 }, { fileId: String(b._id), page: 4 }])).body.message).toMatch(/Page 4 of "b.pdf" does not exist/);
    expect((await post([{ fileId: String(a._id), page: 1, rotate: 45 }, { fileId: String(b._id), page: 1 }])).status).toBe(400);
  });
});

describe('details and confidentiality', () => {
  test('a medical page merged with a general page forces restricted (and it can never be lowered)', async () => {
    const med = await upload('med.pdf', await textPdf([long('Medical certification for John Smith.')]));
    const gen = await upload('gen.pdf', await textPdf([long('General memo.')]));
    await File.updateOne({ _id: med._id }, { confidentiality: 'restricted' });
    await File.updateOne({ _id: gen._id }, { confidentiality: 'general' });
    const pages = pagesOf(med, gen);

    // other staff without restricted access can't even see the medical page
    expect((await request(app).post('/api/merge').send({ userId: String(other._id), pages })).status).toBe(404);

    const pv = await request(app).post('/api/merge/preview').send({ userId: String(admin._id), fileIds: [med._id, gen._id] });
    expect(pv.body).toMatchObject({ mixedRestricted: true, confidentiality: 'restricted' });
    const noAck = await request(app).post('/api/merge').send({ userId: String(admin._id), pages });
    expect(noAck.status).toBe(409);
    expect(noAck.body.needsAcknowledgement).toBe('restricted');

    const r = await request(app).post('/api/merge').send({ userId: String(admin._id), pages, acknowledgeRestricted: true });
    expect(r.body.confidentiality).toBe('restricted');
    await settle();
    const m = await File.findById(r.body.fileId);
    expect(m.confidentiality).toBe('restricted');
    // trying to save it as General keeps it Restricted
    const put = await request(app)
      .put(`/api/files/${m._id}/metadata`)
      .send({ userId: String(admin._id), metadata: { documentType: 'personnel.other-official-personnel-documents', personId: 'emp-1045', confidentialityLevel: 'General' } });
    expect(put.body.metadata.confidentialityLevel).toBe('Restricted');
    expect((await File.findById(m._id)).confidentiality).toBe('restricted');
  });

  test('sources about different people must be resolved; agreed details pre-fill the result', async () => {
    const a = await upload('a.pdf', await textPdf([long('Smith form.')]));
    const b = await upload('b.pdf', await textPdf([long('Patel form.')]));
    const c = await upload('c.pdf', await textPdf([long('Smith addendum.')]));
    const md = (personId, employeeName) => ({ documentType: 'personnel.personnel-agreements', personId, employeeName });
    await File.updateOne({ _id: a._id }, { metadata: md('emp-1045', 'John Smith') });
    await File.updateOne({ _id: b._id }, { metadata: md('emp-2087', 'Priya Patel') });
    await File.updateOne({ _id: c._id }, { metadata: md('emp-1045', 'John Smith') });

    const pv = (await request(app).post('/api/merge/preview').send({ userId: uid(), fileIds: [a._id, b._id] })).body;
    expect(pv.conflicts).toEqual([
      {
        field: 'person',
        values: [
          { value: 'id:emp-1045', label: 'John Smith', fileIds: [String(a._id)] },
          { value: 'id:emp-2087', label: 'Priya Patel', fileIds: [String(b._id)] },
        ],
      },
    ]);
    expect(pv.agreed.documentType.value).toBe('personnel.personnel-agreements');

    const refused = await request(app).post('/api/merge').send({ userId: uid(), pages: pagesOf(a, b) });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/disagree on the person/);
    expect((await request(app).post('/api/merge').send({ userId: uid(), pages: pagesOf(a, b), resolution: { person: 'id:emp-9999' } })).status).toBe(400);

    const ok = await request(app).post('/api/merge').send({ userId: uid(), pages: pagesOf(a, b), resolution: { person: 'id:emp-2087' } });
    expect(ok.status).toBe(200);
    // agreeing sources need no choice
    const ok2 = await request(app).post('/api/merge').send({ userId: uid(), pages: pagesOf(a, c) });
    expect(ok2.status).toBe(200);
    await settle();
    const m = await File.findById(ok.body.fileId);
    // AI is off in tests: the resolved details become the suggestion to confirm
    expect(m.classification.suggestion).toMatchObject({ documentType: 'personnel.personnel-agreements', person: { match: { personId: 'emp-2087' } } });
    const audit = await AuditEvent.findOne({ action: 'document.merged', documentId: m._id }).lean();
    expect(audit.details.resolved).toEqual({ person: 'id:emp-2087' });
  });

  test('split originals and superseded documents cannot be merged', async () => {
    const a = await upload('a.pdf', await textPdf([long('Alpha one.'), long('Alpha two.')]));
    const b = await upload('b.pdf', await textPdf([long('Beta one.')]));
    await request(app).post(`/api/files/${a._id}/split`).send({ userId: uid(), parts: [{ from: 1, to: 1 }, { from: 2, to: 2 }] });
    await settle();
    const r = await request(app).post('/api/merge').send({ userId: uid(), pages: pagesOf(a, b) });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/was split — merge its parts instead/);
    // its parts can be merged back with something else
    const [p1] = await File.find({ parentDocumentId: a._id }).sort({ 'splitFrom.part': 1 });
    expect((await request(app).post('/api/merge').send({ userId: uid(), pages: pagesOf(p1, b) })).status).toBe(200);
  });
});
