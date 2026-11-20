const fs = require('fs');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle, recoverStuck } = require('../../src/features/intake/pipeline');
const { runPipeline } = require('../../src/features/intake/runner');
const File = require('../../src/models/File');
const User = require('../../src/models/User');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');

const app = createApp();
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

async function upload(name, type) {
  const res = await request(app)
    .post('/api/files')
    .field('userId', String(user._id))
    .attach('files', fs.readFileSync(fixture(name)), { filename: name, contentType: type });
  expect(res.status).toBe(201);
  await onIdle();
  return File.findById(res.body.files[0].fileId);
}

describe('upload → pipeline → ready', () => {
  test.each([
    ['evaluation.txt', 'text/plain', 'John Smith'],
    ['offer.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Priya Patel'],
    ['w4_typed.pdf', 'application/pdf', 'Carlos Rivera'],
  ])('%s becomes ready with text, hash, overview and history', async (name, type, expectedText) => {
    const f = await upload(name, type);
    expect(f.status).toBe('ready');
    expect(f.stage).toBe('done');
    expect(f.rawText).toContain(expectedText);
    expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.sizeBytes).toBe(fs.statSync(fixture(name)).size);
    expect(f.source).toBe('upload');
    expect(f.summary).toBe('Test summary');
    expect(f.stageHistory.filter((h) => h.status === 'done').map((h) => h.stage)).toEqual([
      'store', 'hash', 'extract', 'separate', 'dedupe', 'classify', 'index', 'render', 'handoff',
    ]);
    // the original file is in storage
    expect(fakes.__objects.has(f.s3Key)).toBe(true);

    const actions = (await AuditEvent.find({ documentId: f._id })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['document.uploaded', 'document.ready']));
  });

  test('identical content gets the same fingerprint', async () => {
    const a = await upload('evaluation.txt', 'text/plain');
    const b = await upload('evaluation.txt', 'text/plain');
    expect(a.sha256).toBe(b.sha256);
  });
});

describe('failures', () => {
  test('image while Textract is not activated → failed once, with a readable error', async () => {
    const f = await upload('w4_scan.png', 'image/png');
    expect(f.status).toBe('failed');
    expect(f.errorCode).toBe('OCR_NOT_ACTIVATED');
    expect(f.error).toMatch(/OCR service \(AWS Textract\) is not activated/);
    const failed = f.stageHistory.find((h) => h.status === 'failed');
    expect(failed.stage).toBe('extract');
    expect(failed.attempts).toBe(1); // not retryable → no pointless retries

    const ev = await AuditEvent.findOne({ documentId: f._id, action: 'pipeline.failed' });
    expect(ev.details.code).toBe('OCR_NOT_ACTIVATED');
  });

  async function makeDoc() {
    fakes.__objects.set('k1', Buffer.from('hello'));
    return File.create({ userId: user._id, fileName: 'a.txt', s3Key: 'k1', mimeType: 'text/plain' });
  }

  test('a transient failure is retried and then succeeds', async () => {
    const doc = await makeDoc();
    let calls = 0;
    const stages = [
      { name: 'flaky', blocking: true, run: async () => { if (++calls < 3) throw new Error('temporary glitch'); } },
    ];
    expect(await runPipeline(doc._id, { stages })).toBe('ready');
    const f = await File.findById(doc._id);
    expect(f.status).toBe('ready');
    expect(f.stageHistory[0]).toMatchObject({ stage: 'flaky', status: 'done', attempts: 3 });
  });

  test('a persistent failure stops after the max attempts with the error saved', async () => {
    const doc = await makeDoc();
    const stages = [{ name: 'broken', blocking: true, run: async () => { throw new Error('still broken'); } }];
    expect(await runPipeline(doc._id, { stages })).toBe('failed');
    const f = await File.findById(doc._id);
    expect(f.status).toBe('failed');
    expect(f.error).toBe('still broken');
    expect(f.stageHistory[0]).toMatchObject({ stage: 'broken', status: 'failed', attempts: 4 });
  });

  test('a non-blocking stage failure does not fail the document', async () => {
    const doc = await makeDoc();
    const stages = [
      { name: 'core', blocking: true, run: async () => ({ rawText: 'ok' }) },
      { name: 'extra', blocking: false, run: async () => { throw new Error('optional step failed'); } },
    ];
    expect(await runPipeline(doc._id, { stages })).toBe('ready');
    const f = await File.findById(doc._id);
    expect(f.status).toBe('ready');
    expect(await AuditEvent.countDocuments({ documentId: doc._id, action: 'pipeline.stage_failed' })).toBe(1);
  });

  test('a document deleted mid-pipeline stops cleanly', async () => {
    const doc = await makeDoc();
    const stages = [{ name: 'del', blocking: true, run: async () => { await File.deleteOne({ _id: doc._id }); } }];
    expect(await runPipeline(doc._id, { stages })).toBe('missing');
  });
});

describe('very long documents', () => {
  test('text over the storage cap is kept in full in S3 and capped on the record; delete removes both', async () => {
    const long = 'Employee: John Smith. '.repeat(6000); // 132k chars > 50k test cap
    const res = await request(app)
      .post('/api/files')
      .field('userId', String(user._id))
      .attach('files', Buffer.from(long), { filename: 'long.txt', contentType: 'text/plain' });
    await onIdle();
    const f = await File.findById(res.body.files[0].fileId);
    expect(f.status).toBe('ready');
    expect(f.textTruncated).toBe(true);
    expect(f.textLength).toBe(long.length);
    expect(f.rawText).toHaveLength(50000);
    expect(fakes.__objects.get(f.textS3Key).toString()).toBe(long);

    await request(app).delete(`/api/files/${f._id}`);
    expect(fakes.__objects.has(f.textS3Key)).toBe(false);
    expect(fakes.__objects.has(f.s3Key)).toBe(false);
  });
});

describe('restart recovery', () => {
  test('documents left in "processing" are resumed on start-up', async () => {
    fakes.__objects.set('stuck-key', fs.readFileSync(fixture('evaluation.txt')));
    const doc = await File.create({
      userId: user._id, fileName: 'evaluation.txt', s3Key: 'stuck-key', mimeType: 'text/plain', status: 'processing',
      stageHistory: [{ stage: 'store', status: 'done', attempts: 1 }], // already past "store"
    });
    expect(await recoverStuck()).toBe(1);
    await onIdle();
    const f = await File.findById(doc._id);
    expect(f.status).toBe('ready');
    expect(f.rawText).toContain('John Smith');
    // resumed: "store" was not run a second time
    expect(f.stageHistory.filter((h) => h.stage === 'store')).toHaveLength(1);
  });
});
