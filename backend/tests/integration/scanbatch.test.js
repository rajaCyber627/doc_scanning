const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { startDb, clearDb, stopDb } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const config = require('../../src/core/config');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const hot = require('../../src/features/hotfolder/service');
const separators = require('../../src/features/splitting/separators');
const { parsePdf } = require('../../src/features/documents/formats/pdfText');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const Batch = require('../../src/models/Batch');
const Setting = require('../../src/models/Setting');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
let user;
let admin;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  user = await User.create({ email: 'clerk@example.com', userName: 'clerk', password: 'x', permissions: ['restricted'] });
  admin = await User.create({ email: 'admin@example.com', userName: 'admin', password: 'x', permissions: ['admin'] });
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await onIdle();
    await events.idle();
  }
};
const uid = () => String(user._id);

async function startBatch(body = {}) {
  const r = await request(app).post('/api/batches/scan').send({ userId: uid(), ...body });
  expect(r.status).toBe(201);
  return r.body;
}
async function upload(name, buf, batchId) {
  const c = await request(app).post('/api/uploads').send({ userId: uid(), fileName: name, sizeBytes: buf.length, batchId });
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: uid() });
  await settle();
  return File.findById(done.body.file._id);
}
async function pdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of pages) {
    const page = doc.addPage([612, 792]);
    t.split('\n').forEach((line, i) => page.drawText(line, { x: 50, y: 740 - i * 16, size: 10, font }));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
const page = (title, n, of) => `${title}\nPage ${n} of ${of}. This page is part of the City of Portsmouth personnel record and is kept in the employee file.`;
const docPages = (title, n) => Array.from({ length: n }, (_, i) => page(title, i + 1, n));
const answer = (documentType, employeeId) =>
  JSON.stringify({
    documentType,
    confidentialityLevel: 'Confidential',
    restrictedLikely: false,
    person: { name: null, employeeId, applicantNumber: null, quote: null, page: 1 },
    fields: [],
    confidence: { documentType: 0.9, person: 0.9, confidentiality: 0.9 },
  });
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// 6 documents (25 pages) with 5 separator sheets between them = a 30-page stack
const STACK = [
  { title: 'OFFER OF EMPLOYMENT', pages: 4, type: 'personnel.offer-letters', emp: '2087' },
  { title: 'BENEFIT ELECTION FORM', pages: 5, type: 'benefits.benefit-elections', emp: '1045' },
  { title: 'EMPLOYEE HANDBOOK ACKNOWLEDGEMENT', pages: 3, type: 'personnel.employee-acknowledgements', emp: '3310' },
  { title: 'PERSONNEL AGREEMENT', pages: 6, type: 'personnel.personnel-agreements', emp: '1045' },
  { title: 'PROMOTION NOTICE', pages: 4, type: 'personnel.promotions', emp: '2087' },
  { title: 'TRANSFER REQUEST', pages: 3, type: 'personnel.transfers', emp: '3310' },
];
async function stackPdf() {
  const pages = [];
  STACK.forEach((d, i) => {
    if (i > 0) pages.push(`SEPARATOR SHEET\n${separators.encode({ documentType: d.type, employeeId: d.emp })}`);
    pages.push(...docPages(d.title, d.pages));
  });
  if (pages.length !== 30) throw new Error('fixture must have 30 pages');
  return pdf(pages);
}

describe('scan batch end to end', () => {
  test('a 30-page stack with separator sheets → 6 classified documents; reconciliation shows 0 missing pages', async () => {
    await Setting.create({ key: 'classification', value: { aiEnabled: true } });
    const b = await startBatch({ name: 'HR box 12', boxId: 'BOX-12', expectedPages: 30 });
    expect(b).toMatchObject({ kind: 'scan', source: 'scanner', boxId: 'BOX-12', expectedPages: 30, splitMode: 'suggest' });
    for (const d of STACK) fakes.__classifyReplies.push(answer(d.type, d.emp));
    const f = await upload('box-12.pdf', await stackPdf(), b._id);
    await settle();

    expect((await File.findById(f._id)).splitInto).toHaveLength(6);
    const s = (await request(app).get(`/api/batches/${b._id}/scan?userId=${uid()}`)).body;
    expect(s.pages).toEqual({ expected: 30, received: 30, inDocuments: 25, removed: 5, unknown: 0, missing: 0 });
    expect(s.counts).toMatchObject({ received: 1, documents: 6, failed: 0 });
    expect(s.documents.map((d) => d.pages)).toEqual([4, 5, 3, 6, 4, 3]);
    // each part was classified separately (the stack itself was not)
    expect(fakes.__anthropicCalls.filter((c) => c.output_config && c.output_config.format)).toHaveLength(6);
    const kids = await File.find({ parentDocumentId: f._id }).sort({ 'splitFrom.part': 1 });
    expect(kids.every((k) => k.classification.status === 'suggested')).toBe(true);
    // parts 2–6 follow a separator sheet: its details win over whatever the AI said
    // (part 1 has no sheet in front of it; its type is the AI's)
    expect(kids.slice(1).map((k) => k.classification.suggestion.documentType)).toEqual(STACK.slice(1).map((d) => d.type));
    expect(s.byType.map((g) => g.documents).reduce((a, n) => a + n, 0)).toBe(6);

    const csv = await request(app).get(`/api/batches/${b._id}/reconciliation.csv?userId=${uid()}`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toMatch(/\r\nReceived,30\r\n/);
    expect(csv.text).toMatch(/\r\nIn documents,25\r\n/);
    expect(csv.text).toMatch(/\r\n"Removed \(separator sheets, blank pages\)",5\r\n/);
    expect(csv.text).toMatch(/\r\nMissing,0\r\n/);
    expect(csv.text).toMatch(/Box \/ folder ID,BOX-12/);
    const pdfRes = await request(app).get(`/api/batches/${b._id}/reconciliation.pdf?userId=${uid()}`).buffer(true).parse(binary);
    const text = (await parsePdf(pdfRes.body)).text;
    expect(text).toMatch(/RECONCILIATION REPORT/);
    expect(text).toMatch(/Missing \.+ 0/);
    expect(await AuditEvent.countDocuments({ action: 'batch.report_generated' })).toBe(2);
    expect(await AuditEvent.countDocuments({ action: 'batch.started' })).toBe(1);

    // finishing the batch completes it once everything is final
    await request(app).post(`/api/batches/${b._id}/close`).send({ userId: uid() });
    await settle();
    expect((await Batch.findById(b._id)).status).toBe('completed');
    expect(await AuditEvent.countDocuments({ action: 'batch.completed' })).toBe(1);
  });

  test('a stack without separator sheets: the AI suggests cuts for a person to check (default)', async () => {
    await Setting.create({ key: 'classification', value: { aiEnabled: true } });
    const b = await startBatch({ boxId: 'BOX-13' });
    fakes.__classifyReplies.push(JSON.stringify({ documents: [{ startPage: 1, documentType: 'personnel.offer-letters', reason: 'Start', confidence: 0.9 }, { startPage: 3, documentType: 'personnel.transfers', reason: "Page 3 starts 'TRANSFER REQUEST'", confidence: 0.92 }] }));
    const f = await upload('stack.pdf', await pdf([...docPages('OFFER OF EMPLOYMENT', 2), ...docPages('TRANSFER REQUEST', 2)]), b._id);
    expect(f.status).toBe('needs_review');
    expect(f.reviewReasons[0]).toMatchObject({ stage: 'splitting', code: 'SPLIT_SUGGESTED', message: 'This looks like 2 documents — check the suggested cuts in the page view' });
    expect(f.classification).toEqual({}); // not classified while the split is open
    expect(f.splitSuggestion.cuts.map((c) => c.page)).toEqual([3]);
    expect((await request(app).post(`/api/files/${f._id}/review`).send({ userId: uid() })).status).toBe(409);
    const s = (await request(app).get(`/api/batches/${b._id}/scan?userId=${uid()}`)).body;
    expect(s.counts.split_suggested).toBe(1);

    // "keep as one document": the suggestion goes, the document is classified now
    fakes.__classifyReplies.push(answer('personnel.offer-letters', '2087'));
    const k = await request(app).post(`/api/files/${f._id}/split/keep`).send({ userId: uid() });
    expect(k.status).toBe(200);
    const after = await File.findById(f._id);
    expect(after.reviewReasons.map((r) => r.stage)).toEqual(['classification']);
    expect(after.classification.status).toBe('suggested');
    expect(after.resolvedReviewReasons.find((r) => r.code === 'SPLIT_SUGGESTED').resolution).toBe('kept_whole');
    expect((await request(app).post(`/api/files/${f._id}/split/keep`).send({ userId: uid() })).status).toBe(409);
  });

  test('splitMode "auto" applies the AI cuts; "separators" leaves unseparated stacks alone', async () => {
    await Setting.create({ key: 'classification', value: { aiEnabled: true } });
    const auto = await startBatch({ boxId: 'A', splitMode: 'auto' });
    fakes.__classifyReplies.push(
      JSON.stringify({ documents: [{ startPage: 1, documentType: null, reason: 'Start', confidence: 0.9 }, { startPage: 3, documentType: null, reason: 'New form', confidence: 0.9 }] }),
      answer('personnel.offer-letters', '2087'),
      answer('personnel.transfers', '3310')
    );
    const f = await upload('stack.pdf', await pdf([...docPages('OFFER OF EMPLOYMENT', 2), ...docPages('TRANSFER REQUEST', 2)]), auto._id);
    await settle();
    expect((await File.findById(f._id)).splitInto).toHaveLength(2);
    expect((await AuditEvent.findOne({ action: 'document.split' }).lean()).details.via).toBe('ai');

    const only = await startBatch({ boxId: 'B', splitMode: 'separators' });
    fakes.__classifyReplies.push(answer('personnel.offer-letters', '2087'));
    const g = await upload('stack2.pdf', await pdf([...docPages('OFFER OF EMPLOYMENT', 2), ...docPages('TRANSFER REQUEST', 3)]), only._id);
    expect(g.splitInto).toHaveLength(0);
    expect(g.reviewReasons.some((r) => r.stage === 'splitting')).toBe(false);
  });

  test('scanner folder named after the box ID feeds the scan batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanshare-'));
    config.hotfolder.root = root;
    config.hotfolder.stableSec = 0;
    try {
      const b = await startBatch({ boxId: 'BOX-12' });
      await request(app).put('/api/hotfolders').send({ userId: String(admin._id), profiles: [{ name: 'HR copier', kind: 'local', path: 'hr', ownerEmail: 'clerk@example.com' }] });
      fs.mkdirSync(path.join(root, 'hr', 'box-12'), { recursive: true });
      fs.writeFileSync(path.join(root, 'hr', 'box-12', 'scan001.pdf'), await pdf(docPages('OFFER OF EMPLOYMENT', 2)));
      await hot.pollAll();
      await settle();
      const f = await File.findOne({ fileName: 'scan001.pdf' });
      expect(String(f.batchId)).toBe(String(b._id));
      expect(f.source).toBe('scanner');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('validation', async () => {
    expect((await request(app).post('/api/batches/scan').send({ userId: uid(), expectedPages: 'lots' })).status).toBe(400);
    expect((await request(app).post('/api/batches/scan').send({ userId: uid(), boxId: 'a<b>' })).status).toBe(400);
    const b = await startBatch({});
    expect(b.name).toMatch(/^Scan · \d{4}-\d{2}-\d{2}$/);
    expect((await request(app).get(`/api/batches/${b._id}/scan?userId=${String(admin._id)}`)).status).toBe(404); // not their batch
  });
});

describe('quality control', () => {
  test('sampling takes the configured percentage; pass / fail are recorded; a fail is marked for rescan', async () => {
    const b = await startBatch({ boxId: 'QC' });
    const f = await upload('box.pdf', await stackPdf(), b._id); // 6 documents (AI off: separator details only)
    await settle();
    expect((await File.findById(f._id)).splitInto).toHaveLength(6);

    // default 10% of 6 → 1 document
    const s1 = (await request(app).post(`/api/batches/${b._id}/qc/sample`).send({ userId: uid() })).body;
    expect(s1).toMatchObject({ percent: 10, eligible: 6, pending: 1 });
    expect(s1.items).toHaveLength(1);
    // admin sets 50% → 3 of 6
    expect((await request(app).put('/api/settings/qc').send({ userId: uid(), settings: { percent: 50 } })).status).toBe(403);
    await request(app).put('/api/settings/qc').send({ userId: String(admin._id), settings: { percent: 50 } });
    const s2 = (await request(app).post(`/api/batches/${b._id}/qc/sample`).send({ userId: uid() })).body;
    expect(s2.items).toHaveLength(3);
    expect(new Set(s2.items.map((i) => i.fileId)).size).toBe(3);

    const [a, c] = s2.items;
    const rec = (fileId, body) => request(app).post(`/api/batches/${b._id}/qc/${fileId}`).send({ userId: uid(), ...body });
    expect((await rec(a.fileId, { result: 'fail' })).status).toBe(400); // needs a reason
    expect((await rec(String(f._id), { result: 'pass' })).status).toBe(404); // not in the sample
    expect((await rec(a.fileId, { result: 'pass' })).body).toMatchObject({ passed: 1, failed: 0, pending: 2 });
    const failed = (await rec(c.fileId, { result: 'fail', note: 'page 2 is cut off' })).body;
    expect(failed).toMatchObject({ passed: 1, failed: 1, pending: 1 });

    const bad = await File.findById(c.fileId);
    expect(bad.rescan).toMatchObject({ note: 'page 2 is cut off' });
    expect(bad.status).toBe('needs_review');
    expect(bad.reviewReasons.find((r) => r.code === 'RESCAN').message).toBe('Failed the quality check: page 2 is cut off — rescan the paper original');
    const s = (await request(app).get(`/api/batches/${b._id}/scan?userId=${uid()}`)).body;
    expect(s.counts.rescan).toBe(1);
    expect(s.qc).toMatchObject({ passed: 1, failed: 1, pending: 1 });

    // a new sample would discard results → must be asked for explicitly
    expect((await request(app).post(`/api/batches/${b._id}/qc/sample`).send({ userId: uid() })).status).toBe(409);
    const r = (await request(app).get(`/api/batches/${b._id}/reconciliation.csv?userId=${uid()}`)).text;
    expect(r).toMatch(/Quality check,3 of 6 documents \(50%\)/);
    expect(r).toMatch(/Rescan,.*page 2 is cut off/);
    expect(await AuditEvent.countDocuments({ action: 'batch.qc_sampled' })).toBe(2);
    expect(await AuditEvent.countDocuments({ action: 'batch.qc_result' })).toBe(2);

    // passing it after a rescan clears the flag
    await rec(c.fileId, { result: 'pass' });
    expect((await File.findById(c.fileId)).rescan).toBeNull();
  });
});
