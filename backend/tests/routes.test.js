jest.mock('../src/clients', () => require('./fakes/clients'));
jest.mock('axios', () => ({ post: jest.fn(() => Promise.reject(new Error('network disabled in tests'))) }));

const fs = require('fs');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('./helpers');
const fakes = require('./fakes/clients');
const { createApp } = require('../src/app');
const { onIdle } = require('../src/pipeline');
const User = require('../src/models/User');
const File = require('../src/models/File');
const AuditEvent = require('../src/models/AuditEvent');
const MockPartnerRecord = require('../src/models/MockPartnerRecord');

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

const uid = () => String(user._id);

async function uploadOne(name = 'evaluation.txt', type = 'text/plain') {
  const res = await request(app)
    .post('/api/files')
    .field('userId', uid())
    .attach('files', fs.readFileSync(fixture(name)), { filename: name, contentType: type });
  await onIdle();
  return res.body.files[0].fileId;
}

describe('existing document routes keep working', () => {
  test('list, detail, text, in-document search and raw stream', async () => {
    const id = await uploadOne();

    const list = await request(app).get(`/api/files?userId=${uid()}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].rawText).toBeUndefined(); // still light

    const detail = await request(app).get(`/api/files/${id}`);
    expect(detail.body.file.fileName).toBe('evaluation.txt');
    expect(detail.body.viewUrl).toMatch(/^https:\/\/fake-s3\.local\//);
    expect(detail.body.tables).toEqual([]);

    expect((await request(app).get(`/api/files/${id}/text`)).body.text).toContain('Probation');
    const s = await request(app).get(`/api/files/${id}/search?q=probation`);
    expect(s.body.count).toBe(1);

    const raw = await request(app).get(`/api/files/${id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.text).toContain('John Smith');

    const all = await request(app).get(`/api/search?userId=${uid()}&q=smith`);
    expect(all.body.results[0].fileId).toBe(id);
  });

  test('rename + tags are saved and audited with before/after', async () => {
    const id = await uploadOne();
    const res = await request(app).patch(`/api/files/${id}`).send({ fileName: 'Eval 2025.txt', tags: ['hr', 'eval'] });
    expect(res.status).toBe(200);
    expect(res.body.fileName).toBe('Eval 2025.txt');
    const ev = await AuditEvent.findOne({ documentId: id, action: 'document.updated' });
    expect(ev.details.fileName).toEqual({ from: 'evaluation.txt', to: 'Eval 2025.txt' });
    expect(ev.details.tags.to).toEqual(['hr', 'eval']);
  });

  test('delete removes the record and the stored file, and is audited', async () => {
    const id = await uploadOne();
    const { s3Key } = await File.findById(id);
    expect((await request(app).delete(`/api/files/${id}`)).status).toBe(200);
    expect(await File.findById(id)).toBeNull();
    expect(fakes.__objects.has(s3Key)).toBe(false);
    expect(await AuditEvent.countDocuments({ documentId: id, action: 'document.deleted' })).toBe(1);
  });

  test('multi-file upload creates a set; set page and set delete work', async () => {
    const res = await request(app)
      .post('/api/files')
      .field('userId', uid())
      .field('folderName', 'Onboarding')
      .attach('files', fs.readFileSync(fixture('evaluation.txt')), { filename: 'a.txt', contentType: 'text/plain' })
      .attach('files', fs.readFileSync(fixture('w4_typed.pdf')), { filename: 'b.pdf', contentType: 'application/pdf' });
    await onIdle();
    expect(res.status).toBe(201);
    const { folderId } = res.body;
    expect(folderId).toBeTruthy();

    const set = await request(app).get(`/api/folders/${folderId}`);
    expect(set.body.folder.name).toBe('Onboarding');
    expect(set.body.files.map((f) => f.status)).toEqual(['ready', 'ready']);

    expect((await request(app).get(`/api/folders?userId=${uid()}`)).body).toHaveLength(1);
    expect((await request(app).delete(`/api/folders/${folderId}`)).status).toBe(200);
    expect(await File.countDocuments({ folderId })).toBe(0);
    expect(await AuditEvent.countDocuments({ action: 'folder.deleted' })).toBe(1);
  });

  test('saved prompts and saved tables', async () => {
    const id = await uploadOne();
    const p = await request(app).post('/api/prompts').send({ userId: uid(), title: 'IDs', prompt: 'List employee IDs' });
    expect(p.status).toBe(201);
    expect((await request(app).get(`/api/prompts?userId=${uid()}`)).body).toHaveLength(1);

    const t = await request(app).post(`/api/files/${id}/tables`).send({ query: 'q', data: [{ a: 1 }] });
    expect(t.status).toBe(201);
    const renamed = await request(app).patch(`/api/tables/${t.body._id}`).send({ title: 'My table' });
    expect(renamed.body.title).toBe('My table');
    expect((await request(app).get(`/api/tables?userId=${uid()}`)).body).toHaveLength(1);
  });
});

describe('audit events are forwarded and append-only', () => {
  test('every audit event is pushed to the (mock) partner', async () => {
    await uploadOne();
    await new Promise((r) => setImmediate(r)); // partner push is fire-and-forget
    const audits = await AuditEvent.countDocuments();
    expect(audits).toBeGreaterThan(0);
    expect(await MockPartnerRecord.countDocuments({ kind: 'audit' })).toBe(audits);
  });

  test('audit events cannot be edited', async () => {
    const id = await uploadOne();
    const ev = await AuditEvent.findOne({ documentId: id });
    await expect(AuditEvent.updateOne({ _id: ev._id }, { action: 'tampered' })).rejects.toThrow(/append-only/);
    ev.action = 'tampered';
    await expect(ev.save()).rejects.toThrow(/append-only/);
  });
});
