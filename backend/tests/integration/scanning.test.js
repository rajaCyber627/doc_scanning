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
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const Batch = require('../../src/models/Batch');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const HotFolderImport = require('../../src/features/hotfolder/HotFolderImport.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
let user;
let admin;
let root;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  hot._pending.clear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanshare-'));
  config.hotfolder.root = root;
  config.hotfolder.stableSec = 0;
  user = await User.create({ email: 'clerk@example.com', userName: 'clerk', password: 'x' });
  admin = await User.create({ email: 'admin@example.com', userName: 'admin', password: 'x', permissions: ['admin'] });
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await onIdle();
    await events.idle();
  }
};
const aid = () => String(admin._id);

async function textPdf(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 10, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
const body = (s) => `${s} — scanned at the HR front desk copier for the City of Portsmouth personnel records office.`;
const save = (profiles) => request(app).put('/api/hotfolders').send({ userId: aid(), profiles });

describe('scanner folder settings', () => {
  test('admins only; folders must stay inside the scanner share; owner must exist', async () => {
    const p = { name: 'HR copier', kind: 'local', path: 'hr', ownerEmail: 'clerk@example.com' };
    expect((await request(app).put('/api/hotfolders').send({ userId: String(user._id), profiles: [p] })).status).toBe(403);
    expect((await save([{ ...p, path: '../../etc' }])).body.message).toMatch(/inside the scanner share/);
    expect((await save([{ ...p, ownerEmail: 'nobody@example.com' }])).body.message).toMatch(/staff member who owns/);
    expect((await save([p, { ...p, path: 'other' }])).body.message).toMatch(/different name/);
    expect((await save([{ ...p, kind: 's3', prefix: '' }])).body.message).toMatch(/S3 prefix/);
    const ok = await save([p]);
    expect(ok.status).toBe(200);
    expect(ok.body[0]).toMatchObject({ name: 'HR copier', kind: 'local', path: 'hr', ownerId: String(user._id), batchMode: 'subfolder', enabled: true });
    expect((await request(app).get(`/api/hotfolders?userId=${aid()}`)).body).toMatchObject({ root, intervalSec: 30 });
  });
});

describe('local hot folder', () => {
  test('new scans are imported (source = scanner, batch per sub-folder), moved aside, never twice', async () => {
    await save([{ name: 'HR copier', kind: 'local', path: 'hr', ownerEmail: 'clerk@example.com' }]);
    fs.mkdirSync(path.join(root, 'hr', 'box-12'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hr', 'w4-smith.pdf'), await textPdf(body('W-4 for John Smith')));
    fs.writeFileSync(path.join(root, 'hr', 'box-12', 'offer-patel.pdf'), await textPdf(body('Offer letter for Priya Patel')));
    fs.writeFileSync(path.join(root, 'hr', 'setup.exe'), 'MZ fake');
    fs.writeFileSync(path.join(root, 'hr', 'notes.pdf'), 'not really a pdf');

    const r = await request(app).post('/api/hotfolders/poll').send({ userId: aid() });
    expect(r.body).toEqual([{ profile: 'HR copier', imported: 2, rejected: 2, waiting: 0, errors: [] }]);
    await settle();

    const docs = await File.find({ source: 'scanner' }).sort({ fileName: 1 });
    expect(docs.map((d) => d.fileName)).toEqual(['offer-patel.pdf', 'w4-smith.pdf']);
    expect(docs.every((d) => String(d.userId) === String(user._id) && ['ready', 'needs_review'].includes(d.status))).toBe(true);
    expect(docs[0].metadata.capture).toEqual({ device: 'HR copier', folder: 'box-12', path: 'box-12/offer-patel.pdf' });
    expect(docs[1].rawText).toMatch(/W-4 for John Smith/);
    const batch = await Batch.findById(docs[0].batchId);
    expect(batch).toMatchObject({ name: 'Scanner · HR copier · box-12', source: 'scanner' });
    expect(batch.counts.total).toBe(1);

    // the folder shows what happened
    const day = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(root, 'hr', '.imported', day, 'box-12', 'offer-patel.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'hr', '.rejected', day, 'setup.exe'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'hr')).filter((n) => !n.startsWith('.'))).toEqual(['box-12']);
    const rejected = await HotFolderImport.find({ status: 'rejected' }).sort({ path: 1 }).lean();
    expect(rejected.map((x) => [x.path, x.reason])).toEqual([
      ['notes.pdf', expect.stringMatching(/not a real|does not look|PDF/i)],
      ['setup.exe', 'Programs and scripts are never imported'],
    ]);

    const audit = await AuditEvent.findOne({ action: 'document.captured', documentId: docs[1]._id }).lean();
    expect(audit.details).toMatchObject({ source: 'scanner', device: 'HR copier', fileName: 'w4-smith.pdf' });

    // a file put back with the same name/size/time is not imported again
    const again = await request(app).post('/api/hotfolders/poll').send({ userId: aid() });
    expect(again.body[0].imported).toBe(0);
    expect((await request(app).get(`/api/hotfolders/imports?userId=${aid()}`)).body).toHaveLength(4);
  });

  test('a file still being written is left for the next poll', async () => {
    await save([{ name: 'HR copier', kind: 'local', path: 'hr', ownerEmail: 'clerk@example.com' }]);
    fs.mkdirSync(path.join(root, 'hr'));
    fs.writeFileSync(path.join(root, 'hr', 'big.pdf'), await textPdf(body('Large scan')));
    config.hotfolder.stableSec = 60; // written just now → not complete yet
    expect((await hot.pollAll())[0]).toMatchObject({ imported: 0, waiting: 1 });
    config.hotfolder.stableSec = 0;
    expect((await hot.pollAll())[0]).toMatchObject({ imported: 1, waiting: 0 });
  });

  test('a missing folder is reported, other folders still run', async () => {
    await save([
      { name: 'Gone', kind: 'local', path: 'nope', ownerEmail: 'clerk@example.com' },
      { name: 'Front desk', kind: 's3', prefix: 'scanners/front-desk', ownerEmail: 'clerk@example.com', batchMode: 'none' },
    ]);
    fakes.__objects.set('scanners/front-desk/i9-rivera.pdf', await textPdf(body('I-9 for Maria Rivera')));
    const r = await hot.pollAll();
    expect(r[0]).toMatchObject({ profile: 'Gone', errors: ['The folder "nope" does not exist'] });
    expect(r[1]).toMatchObject({ profile: 'Front desk', imported: 1 });
  });
});

describe('S3 hot folder', () => {
  test('objects under the prefix are imported and moved to .imported/', async () => {
    await save([{ name: 'Front desk', kind: 's3', prefix: 'scanners/front-desk/', ownerEmail: 'clerk@example.com', batchMode: 'daily' }]);
    fakes.__objects.set('scanners/front-desk/i9-rivera.pdf', await textPdf(body('I-9 for Maria Rivera')));
    fakes.__objects.set('scanners/front-desk/.imported/2026-01-01/old.pdf', await textPdf(body('old')));
    const r = await hot.pollAll();
    expect(r[0]).toMatchObject({ imported: 1, rejected: 0 });
    await settle();
    const day = new Date().toISOString().slice(0, 10);
    expect(fakes.__objects.has('scanners/front-desk/i9-rivera.pdf')).toBe(false);
    expect(fakes.__objects.has(`scanners/front-desk/.imported/${day}/i9-rivera.pdf`)).toBe(true);
    const f = await File.findOne({ fileName: 'i9-rivera.pdf' });
    expect(f).toMatchObject({ source: 'scanner' });
    expect((await Batch.findById(f.batchId)).name).toBe(`Scanner · Front desk · ${day}`);
  });
});

describe('camera capture', () => {
  async function upload(hints) {
    const buf = await textPdf(body('Camera page'));
    const c = await request(app).post('/api/uploads').send({ userId: String(user._id), fileName: 'scan.pdf', sizeBytes: buf.length, hints });
    const s = await UploadSession.findById(c.body.uploadId);
    fakes.__objects.set(s.s3Key, buf);
    const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: String(user._id) });
    await settle();
    return File.findById(done.body.file._id);
  }

  test('camera uploads are marked as such, with the device in the audit trail; clients cannot claim scanner', async () => {
    const f = await upload({ source: 'camera', device: 'iPhone · Safari', pages: '3' });
    expect(f.source).toBe('camera');
    const a = await AuditEvent.findOne({ action: 'document.captured', documentId: f._id }).lean();
    expect(a.details).toEqual({ source: 'camera', device: 'iPhone · Safari', pages: 3 });
    expect((await upload({ source: 'scanner' })).source).toBe('upload');
  });
});
