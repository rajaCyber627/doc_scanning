const fs = require('fs');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const User = require('../../src/models/User');
const Batch = require('../../src/models/Batch');
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
  user = await User.create({ email: 'hr@example.com', userName: 'hr', firstName: 'Hana', password: 'x' });
  other = await User.create({ email: 'o@example.com', userName: 'o', password: 'x' });
});
afterEach(() => jest.restoreAllMocks());

const uid = () => String(user._id);
const settle = async () => {
  await onIdle();
  await events.idle();
  await onIdle();
  await events.idle();
};

/** Upload one batch item the way the browser does (direct PUT simulated). */
async function uploadItem(batchId, index, name, buf) {
  const c = await request(app).post('/api/uploads').send({ userId: uid(), fileName: name, sizeBytes: buf.length, batchId, batchItem: index });
  expect(c.status).toBe(201);
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  return request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: uid() });
}

const txt = fs.readFileSync(fixture('evaluation.txt'));
const pdf = fs.readFileSync(fixture('w4_typed.pdf'));
const png = fs.readFileSync(fixture('w4_scan.png'));

describe('creating a batch', () => {
  test('records the selected files and gets a default name with date and uploader', async () => {
    const res = await request(app).post('/api/batches').send({
      userId: uid(),
      items: [{ name: 'a.txt', size: 10, path: 'HR/Smith/a.txt' }, { name: 'b.pdf', size: 20 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toMatch(/^Upload · .+ · Hana$/);
    expect(res.body.itemCount).toBe(2);
    expect(res.body.status).toBe('open');
    expect(await AuditEvent.countDocuments({ action: 'batch.created' })).toBe(1);
  });

  test('validation: empty list, bad items, someone else’s folder', async () => {
    expect((await request(app).post('/api/batches').send({ userId: uid(), items: [] })).status).toBe(400);
    expect((await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: '', size: 1 }] })).status).toBe(400);
    const folder = await Folder.create({ userId: other._id, name: 'x' });
    const r = await request(app).post('/api/batches').send({ userId: uid(), folderId: String(folder._id), items: [{ name: 'a', size: 1 }] });
    expect(r.status).toBe(404);
  });
});

describe('batch lifecycle', () => {
  test('uploads → close → processing → completed, with per-file states and counts', async () => {
    const b = (
      await request(app).post('/api/batches').send({
        userId: uid(),
        name: 'Onboarding',
        items: [
          { name: 'evaluation.txt', size: txt.length },
          { name: 'w4.pdf', size: pdf.length },
          { name: 'scan.png', size: png.length },
        ],
      })
    ).body;

    await uploadItem(b._id, 0, 'evaluation.txt', txt);
    await uploadItem(b._id, 1, 'w4.pdf', pdf);
    await settle();
    let batch = await Batch.findById(b._id);
    expect(batch.status).toBe('open'); // not closed yet

    await request(app).post(`/api/batches/${b._id}/close`).send({ userId: uid() });
    await settle();
    batch = await Batch.findById(b._id);
    expect(batch.status).toBe('processing'); // scan.png not uploaded yet
    expect(batch.counts.notUploaded).toBe(1);

    await uploadItem(b._id, 2, 'scan.png', png); // fails in OCR (Textract off)
    await settle();
    batch = await Batch.findById(b._id);
    expect(batch.status).toBe('completed');
    expect(batch.counts).toMatchObject({ total: 3, uploaded: 3, ready: 2, failed: 1, notUploaded: 0, processing: 0 });
    expect(await AuditEvent.countDocuments({ action: 'batch.completed' })).toBe(1);

    const detail = await request(app).get(`/api/batches/${b._id}?userId=${uid()}`);
    expect(detail.body.items.map((i) => i.state)).toEqual(['ready', 'ready', 'failed']);
    expect(detail.body.items[2].error).toMatch(/Textract/);
    expect(detail.body.items[0].documentId).toBeTruthy();
  });

  test('an upload rejected on verification shows as "upload_failed" with the reason', async () => {
    const b = (await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: 'fake.pdf', size: 9 }] })).body;
    const res = await uploadItem(b._id, 0, 'fake.pdf', Buffer.from('not a pdf'));
    expect(res.status).toBe(422);
    await request(app).post(`/api/batches/${b._id}/close`).send({ userId: uid() });
    await settle();
    const detail = await request(app).get(`/api/batches/${b._id}?userId=${uid()}`);
    expect(detail.body.items[0].state).toBe('upload_failed');
    expect(detail.body.items[0].error).toMatch(/does not contain PDF data/);
    expect((await Batch.findById(b._id)).status).toBe('completed');
  });

  test('retry failed re-runs only failed documents', async () => {
    const b = (await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: 'scan.png', size: png.length }, { name: 'e.txt', size: txt.length }] })).body;
    await uploadItem(b._id, 0, 'scan.png', png);
    await uploadItem(b._id, 1, 'e.txt', txt);
    await request(app).post(`/api/batches/${b._id}/close`).send({ userId: uid() });
    await settle();
    const r = await request(app).post(`/api/batches/${b._id}/retry-failed`).send({ userId: uid() });
    expect(r.body.retried).toBe(1);
    await settle();
    const scan = await File.findOne({ batchId: b._id, fileName: 'scan.png' });
    expect(scan.stageHistory.filter((h) => h.stage === 'extract' && h.status === 'failed')).toHaveLength(2);
    const ready = await File.findOne({ batchId: b._id, fileName: 'e.txt' });
    expect(ready.stageHistory.filter((h) => h.stage === 'extract')).toHaveLength(1);
    expect(await AuditEvent.countDocuments({ action: 'batch.retry_failed' })).toBe(1);
  });
});

describe('surviving a page refresh', () => {
  test('files never uploaded stay listed; they can be resumed or cancelled', async () => {
    const b = (
      await request(app).post('/api/batches').send({
        userId: uid(),
        items: [{ name: 'e.txt', size: txt.length }, { name: 'w4.pdf', size: pdf.length }, { name: 'later.txt', size: 5 }],
      })
    ).body;
    await uploadItem(b._id, 0, 'e.txt', txt);
    // browser started item 1 (session pending) then the page was refreshed
    await request(app).post('/api/uploads').send({ userId: uid(), fileName: 'w4.pdf', sizeBytes: pdf.length, batchId: b._id, batchItem: 1 });
    await request(app).post(`/api/batches/${b._id}/close`).send({ userId: uid() });
    await settle();

    let detail = await request(app).get(`/api/batches/${b._id}?userId=${uid()}`);
    expect(detail.body.items.map((i) => i.state)).toEqual(['ready', 'uploading', 'not_uploaded']);
    expect(detail.body.batch.status).toBe('processing');

    // resume item 1 by re-selecting the file
    await uploadItem(b._id, 1, 'w4.pdf', pdf);
    // cancel the rest
    const c = await request(app).post(`/api/batches/${b._id}/cancel-unfinished`).send({ userId: uid() });
    expect(c.body.cancelled).toBe(1);
    await settle();
    detail = await request(app).get(`/api/batches/${b._id}?userId=${uid()}`);
    expect(detail.body.items.map((i) => i.state)).toEqual(['ready', 'ready', 'cancelled']);
    expect(detail.body.batch.status).toBe('completed');
    expect(detail.body.batch.counts).toMatchObject({ total: 2, cancelled: 1 });

    // a cancelled item can no longer be uploaded
    const again = await request(app).post('/api/uploads').send({ userId: uid(), fileName: 'later.txt', sizeBytes: 5, batchId: b._id, batchItem: 2 });
    expect(again.body.code).toBe('ITEM_CANCELLED');
  });

  test('cancelling aborts uploads still in progress', async () => {
    const b = (await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: 'a.txt', size: 5 }] })).body;
    const s = await request(app).post('/api/uploads').send({ userId: uid(), fileName: 'a.txt', sizeBytes: 5, batchId: b._id, batchItem: 0 });
    await request(app).post(`/api/batches/${b._id}/cancel-unfinished`).send({ userId: uid() });
    expect((await UploadSession.findById(s.body.uploadId)).status).toBe('aborted');
  });
});

describe('report, listing and access', () => {
  test('CSV report lists every file with status and totals, safe for spreadsheets', async () => {
    const b = (await request(app).post('/api/batches').send({ userId: uid(), name: 'Q1 =cmd', items: [{ name: '=HYPERLINK(evil).txt', size: txt.length }, { name: 'missing.pdf', size: 3 }] })).body;
    await uploadItem(b._id, 0, '=HYPERLINK(evil).txt', txt);
    await settle();
    const res = await request(app).get(`/api/batches/${b._id}/report.csv?userId=${uid()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const lines = res.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('"#","File name","Folder path","Size (bytes)","Status","Step","Error","Document ID","Uploaded at"');
    expect(lines[1]).toContain(`"'=HYPERLINK(evil).txt"`); // formula neutralised
    expect(lines[1]).toContain('"Ready"');
    expect(lines[2]).toContain('"Not uploaded"');
    expect(res.text).toContain('"files 2"');
  });

  test('batches are private to their creator', async () => {
    const b = (await request(app).post('/api/batches').send({ userId: uid(), items: [{ name: 'a.txt', size: 5 }] })).body;
    expect((await request(app).get(`/api/batches/${b._id}?userId=${other._id}`)).status).toBe(404);
    expect((await request(app).post(`/api/batches/${b._id}/close`).send({ userId: String(other._id) })).status).toBe(404);
    expect((await request(app).get(`/api/batches?userId=${uid()}`)).body).toHaveLength(1);
    expect((await request(app).get(`/api/batches?userId=${other._id}`)).body).toHaveLength(0);
    const up = await request(app).post('/api/uploads').send({ userId: String(other._id), fileName: 'a.txt', sizeBytes: 5, batchId: b._id, batchItem: 0 });
    expect(up.body.code).toBe('BAD_BATCH');
  });

  test('a 500-file batch is accepted and tracked', async () => {
    const body = (i) => `hello ${String(i).padStart(3, '0')}`; // unique content per file
    const items = Array.from({ length: 500 }, (_, i) => ({ name: `doc-${i}.txt`, size: body(i).length }));
    const b = (await request(app).post('/api/batches').send({ userId: uid(), items })).body;
    expect(b.itemCount).toBe(500);
    for (let i = 0; i < 25; i++) await uploadItem(b._id, i, `doc-${i}.txt`, body(i));
    await settle();
    const detail = await request(app).get(`/api/batches/${b._id}?userId=${uid()}`);
    expect(detail.body.batch.counts).toMatchObject({ total: 500, ready: 25, notUploaded: 475, duplicates: 0 });
  });
});
