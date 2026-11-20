const fs = require('fs');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const User = require('../../src/models/User');
const Folder = require('../../src/models/Folder');
const File = require('../../src/models/File');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
let user;
let other;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  user = await User.create({ email: 'hr@example.com', userName: 'hr', password: 'x' });
  other = await User.create({ email: 'other@example.com', userName: 'other', password: 'x' });
});
afterEach(() => jest.restoreAllMocks());

const uid = () => String(user._id);
const create = (body) => request(app).post('/api/uploads').send({ userId: uid(), ...body });
const complete = (id, body = {}) => request(app).post(`/api/uploads/${id}/complete`).send({ userId: uid(), ...body });
const keyOf = async (uploadId) => (await UploadSession.findById(uploadId)).s3Key;
/** Simulate the browser PUT to the presigned URL. */
const putDirect = async (uploadId, buf) => fakes.__objects.set(await keyOf(uploadId), Buffer.from(buf));

describe('GET /api/uploads/config', () => {
  test('returns accepted types, limits and transport for the client', async () => {
    const res = await request(app).get('/api/uploads/config');
    expect(res.status).toBe(200);
    expect(res.body.maxBytes).toBe(100 * 1024 * 1024);
    expect(res.body.transport).toBe('auto');
    expect(res.body.acceptedTypes.map((t) => t.ext)).toEqual(
      expect.arrayContaining(['pdf', 'png', 'jpg', 'tif', 'docx', 'txt', 'csv'])
    );
    expect(res.body.accept).toContain('.pdf');
  });
});

describe('validation before any bytes are sent', () => {
  test.each([
    [{ fileName: 'virus.exe', sizeBytes: 10 }, 415, 'UNSUPPORTED_TYPE'],
    [{ fileName: 'empty.pdf', sizeBytes: 0 }, 400, 'EMPTY_FILE'],
    [{ fileName: 'huge.pdf', sizeBytes: 101 * 1024 * 1024 }, 413, 'TOO_LARGE'],
    [{ fileName: '', sizeBytes: 10 }, 400, 'BAD_NAME'],
  ])('%j → %i', async (body, status, code) => {
    const res = await create(body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(await UploadSession.countDocuments()).toBe(0);
  });

  test('unknown user and someone else’s folder are rejected', async () => {
    const bad = await request(app).post('/api/uploads').send({ userId: '64b000000000000000000009', fileName: 'a.pdf', sizeBytes: 5 });
    expect(bad.body.code).toBe('BAD_USER');
    const folder = await Folder.create({ userId: other._id, name: 'Theirs' });
    const res = await create({ fileName: 'a.pdf', sizeBytes: 5, folderId: String(folder._id) });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('BAD_FOLDER');
  });
});

describe('direct upload (single PUT)', () => {
  test('presign → PUT → complete → document processed to ready', async () => {
    const body = fs.readFileSync(fixture('w4_typed.pdf'));
    const c = await create({ fileName: 'w4_typed.pdf', sizeBytes: body.length, hints: { documentType: 'W-4' } });
    expect(c.status).toBe(201);
    expect(c.body.transport).toBe('direct');
    expect(c.body.url).toMatch(/^https:\/\/fake-s3\.local\//);
    expect(c.body.contentType).toBe('application/pdf');

    await putDirect(c.body.uploadId, body);
    const done = await complete(c.body.uploadId);
    expect(done.status).toBe(201);
    expect(done.body.file.status).toBe('processing');
    expect(done.body.file.metadata).toEqual({ documentType: 'W-4' });

    await onIdle();
    const f = await File.findById(done.body.file._id);
    expect(f.status).toBe('ready');
    expect(f.rawText).toContain('Carlos Rivera');
    expect(f.sizeBytes).toBe(body.length);

    const actions = (await AuditEvent.find().sort({ createdAt: 1 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['upload.started', 'upload.completed', 'document.ready']));
    expect((await UploadSession.findById(c.body.uploadId)).expiresAt).toBeNull();
  });

  test('completing twice returns the same document (idempotent)', async () => {
    const c = await create({ fileName: 'a.txt', sizeBytes: 5 });
    await putDirect(c.body.uploadId, 'hello');
    const a = await complete(c.body.uploadId);
    const b = await complete(c.body.uploadId);
    expect(b.status).toBe(201);
    expect(b.body.file._id).toBe(a.body.file._id);
    await onIdle();
    expect(await File.countDocuments()).toBe(1);
  });
});

describe('verification on complete', () => {
  test('nothing in storage → 422, session failed', async () => {
    const c = await create({ fileName: 'a.pdf', sizeBytes: 100 });
    const res = await complete(c.body.uploadId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NOT_IN_STORAGE');
    expect((await UploadSession.findById(c.body.uploadId)).status).toBe('failed');
  });

  test('size differs from what was announced → 422 and the object is deleted', async () => {
    const c = await create({ fileName: 'a.txt', sizeBytes: 100 });
    await putDirect(c.body.uploadId, 'only a few bytes');
    const res = await complete(c.body.uploadId);
    expect(res.body.code).toBe('SIZE_MISMATCH');
    expect(fakes.__objects.has(await keyOf(c.body.uploadId))).toBe(false);
    expect(await AuditEvent.countDocuments({ action: 'upload.failed' })).toBe(1);
    expect(await File.countDocuments()).toBe(0);
  });

  test('content does not match the extension (renamed file) → 422', async () => {
    const text = Buffer.from('this is not really a PDF');
    const c = await create({ fileName: 'renamed.pdf', sizeBytes: text.length });
    await putDirect(c.body.uploadId, text);
    const res = await complete(c.body.uploadId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONTENT_MISMATCH');
    expect(res.body.message).toMatch(/does not contain PDF data/);
  });

  test('a binary file named .txt is rejected', async () => {
    const png = fs.readFileSync(fixture('w4_scan.png'));
    const c = await create({ fileName: 'notes.txt', sizeBytes: png.length });
    await putDirect(c.body.uploadId, png);
    expect((await complete(c.body.uploadId)).body.code).toBe('CONTENT_MISMATCH');
  });

  test('another user cannot complete or abort my upload', async () => {
    const c = await create({ fileName: 'a.txt', sizeBytes: 5 });
    await putDirect(c.body.uploadId, 'hello');
    const res = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: String(other._id) });
    expect(res.status).toBe(403);
    const ab = await request(app).post(`/api/uploads/${c.body.uploadId}/abort`).send({ userId: String(other._id) });
    expect(ab.status).toBe(403);
  });
});

describe('direct multipart upload (large files)', () => {
  const big = Buffer.from('Employee: John Smith\n'.repeat(130000)); // ~2.7 MB > 1 MB test threshold

  test('parts → complete assembles the file in order', async () => {
    const c = await create({ fileName: 'big.txt', sizeBytes: big.length });
    expect(c.body.multipart.parts).toHaveLength(3);
    const { partSizeBytes } = c.body.multipart;
    const mpId = (await UploadSession.findById(c.body.uploadId)).s3UploadId;
    const parts = c.body.multipart.parts.map((p) => ({
      PartNumber: p.partNumber,
      ETag: fakes.__putPart(mpId, p.partNumber, big.subarray((p.partNumber - 1) * partSizeBytes, p.partNumber * partSizeBytes)),
    }));
    const done = await complete(c.body.uploadId, { parts: parts.reverse() }); // order must not matter
    expect(done.status).toBe(201);
    expect(fakes.__objects.get(await keyOf(c.body.uploadId)).equals(big)).toBe(true);
    await onIdle();
  });

  test('missing parts → 400', async () => {
    const c = await create({ fileName: 'big.txt', sizeBytes: big.length });
    const res = await complete(c.body.uploadId, { parts: [{ PartNumber: 1, ETag: '"x"' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_PARTS');
  });

  test('abort cancels the multipart upload; completing afterwards → 409', async () => {
    const c = await create({ fileName: 'big.txt', sizeBytes: big.length });
    const mpId = (await UploadSession.findById(c.body.uploadId)).s3UploadId;
    const ab = await request(app).post(`/api/uploads/${c.body.uploadId}/abort`).send({ userId: uid(), reason: 'user cancelled' });
    expect(ab.body.status).toBe('aborted');
    expect(fakes.__multiparts.has(mpId)).toBe(false);
    expect((await complete(c.body.uploadId)).status).toBe(409);
  });
});

describe('proxy upload (when the bucket blocks the browser)', () => {
  test('PUT content through the server → complete → ready', async () => {
    const body = fs.readFileSync(fixture('offer.docx'));
    const c = await create({ fileName: 'offer.docx', sizeBytes: body.length, transport: 'proxy' });
    expect(c.body.transport).toBe('proxy');
    const put = await request(app)
      .put(`${c.body.proxyUrl}?userId=${uid()}`)
      .set('Content-Type', 'application/octet-stream')
      .send(body);
    expect(put.status).toBe(200);
    expect(put.body.received).toBe(body.length);
    const done = await complete(c.body.uploadId);
    expect(done.status).toBe(201);
    await onIdle();
    expect((await File.findById(done.body.file._id)).rawText).toContain('Priya Patel');
  });

  test('sending more bytes than announced is refused', async () => {
    const c = await create({ fileName: 'a.txt', sizeBytes: 3, transport: 'proxy' });
    const put = await request(app)
      .put(`${c.body.proxyUrl}?userId=${uid()}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('way more than three bytes'));
    expect(put.status).toBe(413);
  });
});

describe('retry a failed document', () => {
  test('failed → retry → runs the failed stage again; ready documents cannot be retried', async () => {
    const png = fs.readFileSync(fixture('w4_scan.png'));
    const c = await create({ fileName: 'scan.png', sizeBytes: png.length });
    await putDirect(c.body.uploadId, png);
    const { body } = await complete(c.body.uploadId);
    await onIdle();
    expect((await File.findById(body.file._id)).status).toBe('failed'); // Textract not activated

    const r = await request(app).post(`/api/files/${body.file._id}/retry`).send({ userId: uid() });
    expect(r.status).toBe(200);
    expect(r.body.file.status).toBe('processing');
    await onIdle();
    const f = await File.findById(body.file._id);
    expect(f.status).toBe('failed');
    expect(f.stageHistory.filter((h) => h.stage === 'extract' && h.status === 'failed')).toHaveLength(2);
    expect(f.stageHistory.filter((h) => h.stage === 'store')).toHaveLength(1); // not repeated
    expect(await AuditEvent.countDocuments({ action: 'pipeline.retried' })).toBe(1);

    const t = await create({ fileName: 'a.txt', sizeBytes: 5 });
    await putDirect(t.body.uploadId, 'hello');
    const ok = await complete(t.body.uploadId);
    await onIdle();
    expect((await request(app).post(`/api/files/${ok.body.file._id}/retry`).send({})).status).toBe(409);
  });
});
