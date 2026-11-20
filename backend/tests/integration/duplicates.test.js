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
const { fingerprint, similarity } = require('../../src/features/duplicates/fingerprint');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const SearchDoc = require('../../src/models/SearchDoc');
const MockPartnerRecord = require('../../src/providers/partner/MockPartnerRecord.model');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../docs/capture/partner-payload.schema.json'), 'utf8'));
const validatePayload = addFormats(new Ajv({ strict: false })).compile(schema);
let user;
let other;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  user = await User.create({ email: 'hr@example.com', userName: 'hr', firstName: 'Hana', lastName: 'Reed', password: 'x' });
  other = await User.create({ email: 'o@example.com', userName: 'o', firstName: 'Omar', password: 'x' });
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await onIdle();
    await events.idle();
  }
};
const uid = () => String(user._id);
const w4txt = () => fs.readFileSync(fixture('w4.txt'));
const w4pdf = () => fs.readFileSync(fixture('w4_typed.pdf'));

async function upload(name, buf, { as = user, batchId, batchItem } = {}) {
  const c = await request(app).post('/api/uploads').send({ userId: String(as._id), fileName: name, sizeBytes: buf.length, batchId, batchItem });
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: String(as._id) });
  await settle();
  return File.findById(done.body.file._id);
}
const decide = (f, action, reason = 'checked') => request(app).post(`/api/files/${f._id}/duplicate-decision`).send({ userId: uid(), action, reason });

describe('detection', () => {
  test('the same file twice: only the later copy is flagged, naming the earlier one', async () => {
    const a = await upload('w4.pdf', w4pdf());
    const b = await upload('w4 copy.pdf', w4pdf());
    expect(a.status).toBe('ready');
    expect(b.status).toBe('needs_review');
    expect(b.reviewReasons[0]).toMatchObject({ code: 'DUPLICATE_EXACT', stage: 'duplicates' });
    expect(b.reviewReasons[0].message).toMatch(/^Same file as "w4\.pdf" uploaded \d\d\/\d\d\/\d{4}$/);
    expect(b.duplicateOf[0]).toMatchObject({ kind: 'exact', where: 'hub', similarity: 1 });
  });

  test('two copies in one batch say "in this batch"', async () => {
    const batch = (await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: 'a.pdf', size: w4pdf().length }, { name: 'b.pdf', size: w4pdf().length }] })).body;
    await upload('a.pdf', w4pdf(), { batchId: batch._id, batchItem: 0 });
    const b = await upload('b.pdf', w4pdf(), { batchId: batch._id, batchItem: 1 });
    expect(b.reviewReasons[0].message).toMatch(/in this batch$/);
    await request(app).post(`/api/batches/${batch._id}/close`).send({ userId: uid() });
    await settle();
    const detail = await request(app).get(`/api/batches/${batch._id}?userId=${uid()}`);
    expect(detail.body.batch.counts.duplicates).toBe(1);
  });

  test('a text file and its PDF export are the same content (different files)', async () => {
    await upload('w4.txt', w4txt());
    const pdf = await upload('w4.pdf', w4pdf());
    expect(pdf.status).toBe('needs_review');
    expect(pdf.reviewReasons[0]).toMatchObject({ code: 'DUPLICATE_CONTENT' });
    expect(pdf.reviewReasons[0].message).toMatch(/^Same content as "w4\.txt" \(100% similar\)/);
  });

  test('the same paper scanned twice (a few OCR differences) still matches', async () => {
    const text = w4txt().toString();
    await upload('scan1.txt', Buffer.from(text));
    const noisy = await upload('scan2.txt', Buffer.from(text.replace(/Rivera/g, 'Rlvera').replace('federal', 'fedral')));
    expect(noisy.reviewReasons[0]).toMatchObject({ code: 'DUPLICATE_CONTENT' });
  });

  test('the same form filled in for a different employee is NOT a duplicate', async () => {
    const text = w4txt().toString();
    await upload('rivera.txt', Buffer.from(text));
    const brooks = text.replace(/Carlos Rivera/g, 'Dana Brooks').replace('3310', '4410').replace('January 15, 2025', 'March 2, 2026').replace('Dependents: 2', 'Dependents: 0');
    const f = await upload('brooks.txt', Buffer.from(brooks));
    expect(f.status).toBe('ready');
    expect(f.duplicateOf).toEqual([]);
  });

  test('a file already in the partner HR system (but no longer in the hub) is flagged', async () => {
    const first = await upload('w4.pdf', w4pdf());
    await completeMetadata(app, first._id, user._id);
    await settle();
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(1);
    await request(app).delete(`/api/files/${first._id}`); // gone from the hub, still at the partner
    const again = await upload('w4-again.pdf', w4pdf());
    expect(again.reviewReasons[0]).toMatchObject({ code: 'DUPLICATE_PARTNER', message: 'This exact file is already in the HR records system' });
  });
});

describe('restricted records', () => {
  test('an existing restricted copy is only described as "a restricted record", without details', async () => {
    const secret = await upload('medical.pdf', w4pdf(), { as: other });
    await File.updateOne({ _id: secret._id }, { confidentiality: 'restricted' });
    const mine = await upload('w4.pdf', w4pdf());
    expect(mine.reviewReasons[0].message).toBe('A restricted record with the same file already exists');
    const view = await request(app).get(`/api/files/${mine._id}/duplicates?userId=${uid()}`);
    expect(view.body.matches[0]).toEqual({ kind: 'exact', where: 'hub', similarity: 1, sameBatch: false, restricted: true });

    await User.updateOne({ _id: user._id }, { permissions: ['restricted'] });
    const allowed = await request(app).get(`/api/files/${mine._id}/duplicates?userId=${uid()}`);
    expect(allowed.body.matches[0]).toMatchObject({ fileName: 'medical.pdf', uploadedBy: 'Omar', restricted: true });
  });
});

describe('decisions', () => {
  test('compare view shows both documents', async () => {
    const a = await upload('w4.pdf', w4pdf());
    const b = await upload('w4 copy.pdf', w4pdf());
    const view = await request(app).get(`/api/files/${b._id}/duplicates?userId=${uid()}`);
    expect(view.body.document).toMatchObject({ fileName: 'w4 copy.pdf', status: 'needs_review' });
    expect(view.body.open).toBe(true);
    expect(view.body.matches[0]).toMatchObject({ fileId: String(a._id), fileName: 'w4.pdf', uploadedBy: 'Hana Reed', kind: 'exact' });
  });

  test('keep both: ready, reason kept as history, audited with the reason', async () => {
    await upload('w4.pdf', w4pdf());
    const b = await upload('w4 copy.pdf', w4pdf());
    const r = await decide(b, 'keep_both', 'Second copy is the signed original');
    expect(r.body).toMatchObject({ action: 'keep_both', file: { status: 'ready' } });
    const after = await File.findById(b._id);
    expect(after.reviewReasons).toEqual([]);
    expect(after.resolvedReviewReasons[0]).toMatchObject({ code: 'DUPLICATE_EXACT', decision: 'keep_both' });
    const ev = await AuditEvent.findOne({ action: 'duplicate.kept_both' });
    expect(ev.details.reason).toBe('Second copy is the signed original');
    expect((await decide(b, 'keep_both')).status).toBe(409); // nothing left to decide
  });

  test('replace existing: a new version — the old one is kept but hidden from lists and search', async () => {
    const a = await upload('w4.pdf', w4pdf());
    const b = await upload('w4 v2.pdf', w4pdf());
    const r = await decide(b, 'replace', 'Newer scan');
    expect(r.body.replacedFileId).toBe(String(a._id));
    await completeMetadata(app, b._id, user._id);
    await settle();
    const old = await File.findById(a._id);
    expect(old.supersededBy.equals(b._id)).toBe(true); // never deleted
    const list = (await request(app).get(`/api/files?userId=${uid()}`)).body.map((f) => f.fileName);
    expect(list).toEqual(['w4 v2.pdf']);
    const all = (await request(app).get(`/api/files?userId=${uid()}&includeSuperseded=1`)).body;
    expect(all).toHaveLength(2);
    expect(await SearchDoc.countDocuments({ fileId: a._id })).toBe(0);
    const rec = await MockPartnerRecord.findOne({ kind: 'document', 'payload.documentId': String(b._id) });
    expect(validatePayload(rec.payload)).toBe(true);
    expect(rec.payload.supersedesDocumentId).toBe(String(a._id));
    expect(await AuditEvent.countDocuments({ action: 'document.superseded', documentId: a._id })).toBe(1);
  });

  test('discard new: the incoming copy is removed, audited', async () => {
    await upload('w4.pdf', w4pdf());
    const b = await upload('w4 copy.pdf', w4pdf());
    const r = await decide(b, 'discard', 'Accidental re-upload');
    expect(r.body.deleted).toBe(true);
    expect(await File.findById(b._id)).toBeNull();
    expect(fakes.__objects.has(b.s3Key)).toBe(false);
    const ev = await AuditEvent.findOne({ action: 'duplicate.discarded' });
    expect(ev.details).toMatchObject({ reason: 'Accidental re-upload', fileName: 'w4 copy.pdf' });
  });

  test('bulk decision for a batch', async () => {
    await upload('w4.pdf', w4pdf());
    await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt')));
    const batch = (await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: 'x.pdf', size: 1 }, { name: 'y.txt', size: 1 }] })).body;
    await upload('x.pdf', w4pdf(), { batchId: batch._id, batchItem: 0 });
    await upload('y.txt', fs.readFileSync(fixture('evaluation.txt')), { batchId: batch._id, batchItem: 1 });
    const r = await request(app).post(`/api/batches/${batch._id}/duplicate-decision`).send({ userId: uid(), action: 'discard', reason: 'Re-scan of existing files' });
    expect(r.body).toEqual({ decided: 2, errors: [] });
    expect(await File.countDocuments({ batchId: batch._id })).toBe(0);
    expect((await request(app).post(`/api/batches/${batch._id}/duplicate-decision`).send({ userId: String(other._id), action: 'discard' })).status).toBe(404);
  });

  test('"mark as reviewed" cannot skip an open duplicate decision', async () => {
    await upload('w4.pdf', w4pdf());
    const b = await upload('w4 copy.pdf', w4pdf());
    const r = await request(app).post(`/api/files/${b._id}/review`).send({ userId: uid() });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/duplicate/);
  });

  test('preview endpoint serves the best view for the compare screen', async () => {
    const a = await upload('w4.pdf', w4pdf());
    const pdf = await request(app).get(`/api/files/${a._id}/preview`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const zip = await upload('bundle.zip', fs.readFileSync(path.join(__dirname, '../support/fixtures/formats/personnel-files.zip')));
    expect((await request(app).get(`/api/files/${zip._id}/preview`)).status).toBe(404);
  });

  test('invalid actions are refused', async () => {
    await upload('w4.pdf', w4pdf());
    const b = await upload('w4 copy.pdf', w4pdf());
    expect((await decide(b, 'delete_everything')).status).toBe(400);
  });
});

describe('fingerprints', () => {
  test('too little text is not fingerprinted; unrelated documents score low', () => {
    expect(fingerprint('just a few words')).toBeNull();
    const a = fingerprint(w4txt().toString());
    const b = fingerprint(fs.readFileSync(path.join(__dirname, '../support/fixtures/formats/notice.rtf'), 'latin1').repeat(3));
    expect(similarity(a.minhash, b.minhash)).toBeLessThan(0.2);
  });
});
