const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('../support/helpers');
const { completeMetadata } = require('../support/metadata');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const { buildBlocks } = require('../../src/providers/ocr/buildBlocks');
const { snippetFor } = require('../../src/providers/search/mongo');
const { detectLanguage } = require('../../src/features/search/indexer');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const SearchDoc = require('../../src/models/SearchDoc');
const MockPartnerRecord = require('../../src/providers/partner/MockPartnerRecord.model');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
const FX = path.join(__dirname, '../support/fixtures/formats');
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../docs/capture/partner-payload.schema.json'), 'utf8'));
const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
const validatePayload = ajv.compile(schema);
let user;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  fakes.__textract.mode = 'ok';
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
const uid = () => String(user._id);

async function upload(name, buf, { as = user, batchId } = {}) {
  const c = await request(app).post('/api/uploads').send({ userId: String(as._id), fileName: name, sizeBytes: buf.length, batchId });
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: String(as._id) });
  await settle();
  return File.findById(done.body.file._id);
}
const search = (params) => request(app).get('/api/search').query({ userId: uid(), ...params });

describe('full-text search', () => {
  test('a word that exists only inside a scan is found, with a highlighted snippet and its page', async () => {
    fakes.__textract.results.set(
      'default',
      buildBlocks([{ lines: [{ text: 'Cover sheet' }, { text: 'nothing here' }, { text: 'see next page' }] }, { lines: [{ text: 'Grievance filed by Dana Brooks' }, { text: 'about overtime scheduling' }, { text: 'received 03/02/2026' }] }])
    );
    const f = await upload('scan.png', fs.readFileSync(fixture('w4_scan.png')));
    const res = await search({ q: 'overtime' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('text');
    const hit = res.body.results[0];
    expect(hit).toMatchObject({ fileId: String(f._id), page: 2, count: 1 });
    const [a, b] = hit.highlights[0];
    expect(hit.snippet.slice(a, b).toLowerCase()).toBe('overtime');
  });

  test('stemming, exact phrases, exclusions and partial words', async () => {
    await upload('personnel-action.doc', fs.readFileSync(path.join(FX, 'personnel-action.doc'))); // "Promotion to Supervisor"
    await upload('w4_typed.pdf', fs.readFileSync(fixture('w4_typed.pdf'))); // "Married filing jointly", Carlos Rivera
    await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt'))); // John Smith

    expect((await search({ q: 'promotions' })).body.results.map((r) => r.fileName)).toEqual(['personnel-action.doc']);
    expect((await search({ q: '"married filing jointly"' })).body.results.map((r) => r.fileName)).toEqual(['w4_typed.pdf']);
    expect((await search({ q: '"jointly married"' })).body.results).toEqual([]);
    const ex = (await search({ q: 'employee -rivera' })).body.results.map((r) => r.fileName);
    expect(ex).toContain('evaluation.txt');
    expect(ex).not.toContain('w4_typed.pdf');
    const partial = await search({ q: 'Smi' });
    expect(partial.body.mode).toBe('substring');
    expect(partial.body.results.map((r) => r.fileName)).toEqual(['evaluation.txt']);
  });

  test('filters: batch, status, document type and date range', async () => {
    const batch = (await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: 'evaluation.txt', size: 236 }] })).body;
    const inBatch = await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt')), { batchId: batch._id });
    const other = await upload('offer.docx', fs.readFileSync(fixture('offer.docx')));
    await File.updateOne({ _id: other._id }, { 'metadata.documentType': 'Offer Letter' });
    events.emit('document.changed', String(other._id));
    await settle();

    const names = async (p) => (await search(p)).body.results.map((r) => r.fileName).sort();
    expect(await names({ q: '', batchId: batch._id })).toEqual(['evaluation.txt']);
    expect(await names({ q: '', documentType: 'Offer Letter' })).toEqual(['offer.docx']);
    expect(await names({ q: '', from: '2000-01-01', to: '2001-01-01' })).toEqual([]);
    expect(await names({ q: '', from: new Date(Date.now() - 60000).toISOString() })).toEqual(['evaluation.txt', 'offer.docx']);
    fakes.__textract.results.set('default', buildBlocks([{ lines: [{ text: 'blurry words', conf: 40 }, { text: 'hard to see', conf: 40 }, { text: 'faint', conf: 40 }] }]));
    await upload('blurry.png', fs.readFileSync(fixture('w4_scan.png')));
    expect(await names({ q: '', status: 'needs_review' })).toEqual(['blurry.png']);
    expect(inBatch.batchId.equals(batch._id)).toBe(true);
  });

  test('your own restricted documents are found; nobody else ever sees your documents', async () => {
    const f = await upload('doctor-note.txt', Buffer.from('Medical certification for John Smith, return to work 12/01'));
    await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt')));
    await File.updateOne({ _id: f._id }, { confidentiality: 'restricted' });
    events.emit('document.changed', String(f._id));
    await settle();

    // the person who captured the restricted note still finds it
    const mine = await search({ q: 'smith' });
    expect(mine.body.results.map((r) => r.fileName).sort()).toEqual(['doctor-note.txt', 'evaluation.txt']);
    expect((await search({ q: 'medi' })).body.total).toBe(1); // substring fallback too
    // another staff member — even one with restricted access — never sees someone else's documents
    const stranger = await User.create({ email: 'stranger@example.com', userName: 'stranger', password: 'x', permissions: ['restricted'] });
    expect((await request(app).get(`/api/search?userId=${stranger._id}&q=smith`)).body).toMatchObject({ total: 0, results: [] });
  });

  test('the index follows changes: rename re-indexes, delete removes', async () => {
    const f = await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt')));
    await request(app).patch(`/api/files/${f._id}`).send({ fileName: 'Annual Review Smith.txt' });
    await settle();
    expect((await search({ q: 'annual review' })).body.results[0].fileName).toBe('Annual Review Smith.txt');
    await request(app).delete(`/api/files/${f._id}`);
    expect(await SearchDoc.countDocuments()).toBe(0);
  });

  test('search requires a real user', async () => {
    expect((await request(app).get('/api/search?q=x')).status).toBe(400);
  });
});

describe('hand-off to the partner HRDMS', () => {
  test('ready documents are sent (once their details are complete) with a payload matching the published schema', async () => {
    const f = await upload('w4_typed.pdf', fs.readFileSync(fixture('w4_typed.pdf')));
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(0); // details still missing
    await completeMetadata(app, f._id, user._id);
    await settle();
    const rec = await MockPartnerRecord.findOne({ kind: 'document', 'payload.documentId': String(f._id) });
    expect(validatePayload(rec.payload)).toBe(true);
    expect(rec.payload).toMatchObject({ schemaVersion: '1.0', fileName: 'w4_typed.pdf', sha256: f.sha256, index: { language: 'en' } });
    expect(rec.payload.index.text).toContain('Carlos Rivera');
    expect(rec.payload.metadata).toMatchObject({ employeeId: '1045', employeeName: 'John Smith', recordCategory: 'Personnel' });
    const after = await File.findById(f._id);
    expect(after.handoff.partnerDocumentId).toBe(`mock-${rec._id}`);
    expect(await AuditEvent.countDocuments({ action: 'document.handed_off', documentId: f._id })).toBe(1);
  });

  test('a scan with OCR and pages, and an email attachment, both validate', async () => {
    fakes.__textract.results.set('default', buildBlocks([{ lines: [{ text: 'Employee ID: 1045' }, { text: 'Form fields here' }, { text: 'more text' }], keyValues: [['Employee ID', '1045']] }]));
    await upload('scan.png', fs.readFileSync(fixture('w4_scan.png')));
    await upload('intake.eml', fs.readFileSync(path.join(FX, 'intake.eml')));
    for (const f of await File.find()) await completeMetadata(app, f._id, user._id);
    await settle();
    const recs = await MockPartnerRecord.find({ kind: 'document' });
    expect(recs.length).toBe(4); // scan, email, 2 attachments
    for (const r of recs) expect(validatePayload(r.payload) || validatePayload.errors).toBe(true);
    const scan = recs.find((r) => r.payload.fileName === 'scan.png').payload;
    expect(scan.ocr.formFields).toEqual([{ key: 'Employee ID', value: '1045', page: 1 }]);
    expect(scan.files.searchablePdf.s3Key).toMatch(/\.view\.pdf$/);
    const att = recs.find((r) => r.payload.fileName === 'doctor-note.txt').payload;
    expect(att.parentDocumentId).toBe(recs.find((r) => r.payload.fileName === 'intake.eml').payload.documentId);
  });

  test('documents waiting for review are held back until accepted; later changes update the same partner record', async () => {
    fakes.__textract.results.set('default', buildBlocks([{ lines: [{ text: 'hard to read', conf: 40 }, { text: 'very faint', conf: 40 }, { text: 'text', conf: 40 }] }]));
    const f = await upload('faint.png', fs.readFileSync(fixture('w4_scan.png')));
    expect(f.status).toBe('needs_review');
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(0);

    await request(app).post(`/api/files/${f._id}/review`).send({ userId: uid() });
    await settle();
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(0); // reviewed, but details missing
    await completeMetadata(app, f._id, user._id);
    await settle();
    const rec = await MockPartnerRecord.findOne({ kind: 'document' });
    expect(validatePayload(rec.payload)).toBe(true);
    expect(rec.payload.review).toMatchObject({ reviewedBy: uid(), resolvedReasons: ['LOW_CONFIDENCE'] });

    await request(app).patch(`/api/files/${f._id}`).send({ fileName: 'renamed.png' });
    await settle();
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(1); // updated, not duplicated
    const updated = await MockPartnerRecord.findOne({ kind: 'document' });
    expect(updated.payload.fileName).toBe('renamed.png');
    expect(updated.payload.partnerDocumentId).toBe(`mock-${rec._id}`);
    expect(await AuditEvent.countDocuments({ action: 'document.resynced' })).toBeGreaterThanOrEqual(1);
  });
});

describe('helpers', () => {
  test('snippet highlights line up with the text even when whitespace is collapsed', () => {
    const text = `${'x '.repeat(100)}Employee   was\n\npromoted  to supervisor`;
    const s = snippetFor(text, ['promoted', 'supervisor']);
    expect(s.highlights.map(([a, b]) => s.snippet.slice(a, b))).toEqual(['promoted', 'supervisor']);
    expect(s.snippet.startsWith('…')).toBe(true);
  });
  test('language detection: English vs Spanish', () => {
    expect(detectLanguage('The employee is on leave for the week and will return to the office').lang).toBe('en');
    expect(detectLanguage('El empleado está de licencia por la semana y regresa a la oficina con el informe de los gastos').lang).toBe('es');
  });
});
