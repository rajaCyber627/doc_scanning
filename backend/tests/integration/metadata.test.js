const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const { fiscalYearOf } = require('../../src/features/metadata/service');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const MockPartnerRecord = require('../../src/providers/partner/MockPartnerRecord.model');
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
  user = await User.create({ email: 'hr@example.com', userName: 'hr', password: 'x' });
  admin = await User.create({ email: 'admin@example.com', userName: 'admin', password: 'x', permissions: ['admin', 'restricted'] });
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await onIdle();
    await events.idle();
  }
};
const uid = () => String(user._id);

let n = 0;
async function upload(name = 'evaluation.txt', buf) {
  const body = buf || Buffer.from(`${fs.readFileSync(fixture('evaluation.txt'))}\nCopy ${++n}`); // unique, so no duplicates
  const c = await request(app).post('/api/uploads').send({ userId: uid(), fileName: name, sizeBytes: body.length });
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, body);
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: uid() });
  await settle();
  return File.findById(done.body.file._id);
}
const save = (fileId, metadata, as = user) => request(app).put(`/api/files/${fileId}/metadata`).send({ userId: String(as._id), metadata });

describe('taxonomy', () => {
  test('seeded from the RFP: 10 record categories and their document types, plus the standard fields', async () => {
    const t = (await request(app).get('/api/taxonomy')).body;
    expect(t.categories.map((c) => c.name)).toEqual([
      'Personnel', 'Benefits', 'Medical & Confidential', 'FMLA & Leave', 'ADA & Accommodation',
      "Workers' Compensation", 'Employee Relations', 'Recruitment', 'Classification & Compensation', 'Training & Development',
    ]);
    expect(t.documentTypes).toHaveLength(74);
    expect(t.baseFields.map((f) => f.key)).toEqual(expect.arrayContaining(['documentType', 'person', 'effectiveDate', 'fiscalYear', 'confidentialityLevel', 'retentionCategory', 'caseNumber', 'positionNumber']));
    expect(t.documentTypes.find((d) => d.key === 'personnel.offer-letters').fields[0]).toMatchObject({ key: 'startDate', type: 'date', required: true });
    expect(t.documentTypes.find((d) => d.key === 'employee-relations.grievances').defaultConfidentiality).toBe('Restricted');
  });

  test('an admin adds a document type with a custom field; it is used right away', async () => {
    const type = {
      name: 'Commercial driver license',
      categoryKey: 'training-and-development',
      defaultConfidentiality: 'Confidential',
      fields: [
        { key: 'licenseClass', label: 'License class', type: 'select', options: ['A', 'B', 'C'], required: true },
        { key: 'expirationDate', label: 'Expires', type: 'date' },
      ],
    };
    expect((await request(app).put('/api/taxonomy/document-types/training-and-development.cdl').send({ userId: uid(), type })).status).toBe(403);
    const r = await request(app).put('/api/taxonomy/document-types/training-and-development.cdl').send({ userId: String(admin._id), type });
    expect(r.status).toBe(200);
    const t = (await request(app).get('/api/taxonomy')).body;
    expect(t.documentTypes.find((d) => d.key === 'training-and-development.cdl').fields).toHaveLength(2);

    const f = await upload();
    const res = await save(f._id, { documentType: 'training-and-development.cdl', personId: 'emp-1045' });
    expect(res.body.metadataStatus).toBe('incomplete');
    expect(res.body.errors).toEqual([{ field: 'licenseClass', message: 'License class is required' }]);
    expect((await save(f._id, { licenseClass: 'B' })).body.metadataStatus).toBe('complete');
    expect(await AuditEvent.countDocuments({ action: 'taxonomy.type_created' })).toBe(1);
  });

  test('bad type definitions are refused with the reasons', async () => {
    const r = await request(app)
      .put('/api/taxonomy/document-types/BAD KEY')
      .send({ userId: String(admin._id), type: { name: 'x', categoryKey: 'personnel', fields: [{ key: 'employeeId', label: 'x', type: 'text' }, { key: 'pick', label: 'p', type: 'select' }] } });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/^key/), 'field "employeeId" is reserved', 'field "pick": a pick-list needs options']));
  });

  test('export → import round trip; replace mode deactivates (never deletes) missing types', async () => {
    const exported = (await request(app).get('/api/taxonomy/export')).body;
    expect(exported.documentTypes).toHaveLength(74);
    const smaller = { categories: exported.categories, documentTypes: exported.documentTypes.slice(0, 10) };
    const r = await request(app).post('/api/taxonomy/import').send({ userId: String(admin._id), data: smaller, mode: 'replace' });
    expect(r.body).toMatchObject({ documentTypes: 10, mode: 'replace' });
    expect((await request(app).get('/api/taxonomy')).body.documentTypes).toHaveLength(10);
    expect((await request(app).get('/api/taxonomy?all=1')).body.documentTypes).toHaveLength(74);
    const bad = await request(app).post('/api/taxonomy/import').send({ userId: String(admin._id), data: { categories: [], documentTypes: [{ key: 'x', name: 'X', categoryKey: 'nope' }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.details[0]).toMatch(/unknown category "nope"/);
  });
});

describe('metadata entry', () => {
  test('picking an employee fills name, ID, position, department and division (verified with the HR directory)', async () => {
    const people = (await request(app).get('/api/people?q=smi')).body;
    expect(people[0]).toMatchObject({ personId: 'emp-1045', name: 'John Smith' });
    const f = await upload();
    const r = await save(f._id, { documentType: 'personnel.promotions', personId: 'emp-1045', effectiveDate: '2025-08-15' });
    expect(r.body.metadata).toMatchObject({
      employeeName: 'John Smith', employeeId: '1045', positionTitle: 'Equipment Operator II', department: 'Public Works', division: 'Streets',
      recordCategory: 'Personnel', hrFunctionalArea: 'Personnel', confidentialityLevel: 'Confidential', fiscalYear: 'FY2026',
    });
    expect(r.body.metadataStatus).toBe('complete');
    const bogus = await save(f._id, { personId: 'emp-9999' });
    expect(bogus.body.errors).toEqual(expect.arrayContaining([{ field: 'person', message: 'That person was not found in the HR directory' }]));
  });

  test('required, typed and pick-list fields are checked; partial saves are allowed', async () => {
    const f = await upload();
    let r = await save(f._id, {});
    expect(r.body.metadataStatus).toBe('missing');
    r = await save(f._id, { documentType: 'personnel.offer-letters', startDate: '03/03/2026', salary: 'lots' });
    expect(r.status).toBe(200);
    expect(r.body.metadataStatus).toBe('incomplete');
    expect(r.body.errors.map((e) => e.field)).toEqual(expect.arrayContaining(['startDate', 'salary', 'person']));
    r = await save(f._id, { startDate: '2026-03-03', salary: '72500', personId: 'emp-2087', status: 'Sideways' });
    expect(r.body.errors).toEqual([{ field: 'status', message: 'Record status: choose one of Active, Final, Draft, Inactive' }]);
    r = await save(f._id, { status: 'Final' });
    expect(r.body).toMatchObject({ metadataStatus: 'complete', metadata: { salary: 72500, startDate: '2026-03-03' } });
  });

  test('unknown fields are ignored; system values (e.g. email headers) survive edits', async () => {
    const eml = await upload('intake.eml', fs.readFileSync(path.join(__dirname, '../support/fixtures/formats/intake.eml')));
    const r = await save(eml._id, { documentType: 'personnel.other-official-personnel-documents', personId: 'emp-1045', isAdmin: true, $where: 'x' });
    expect(r.body.metadata.isAdmin).toBeUndefined();
    expect(r.body.metadata.$where).toBeUndefined();
    expect(r.body.metadata.email.subject).toMatch(/Doctor note/);
  });

  test('each changed field is audited with old and new values', async () => {
    const f = await upload();
    await save(f._id, { documentType: 'personnel.promotions', personId: 'emp-1045', effectiveDate: '2025-08-15' });
    await save(f._id, { effectiveDate: '2026-02-01' });
    const ev = (await AuditEvent.find({ action: 'metadata.changed', documentId: f._id }).sort({ createdAt: 1 }))[1];
    expect(ev.details.changes).toEqual([{ field: 'effectiveDate', from: '2025-08-15', to: '2026-02-01' }]);
    expect(ev.userId.equals(user._id)).toBe(true);
  });

  test('restricted types make the document restricted: hidden from users without permission', async () => {
    const f = await upload();
    const r = await save(f._id, { documentType: 'fmla-and-leave.fmla-requests', personId: 'emp-1045', caseNumber: 'FMLA-26-014' });
    expect(r.body.metadata.confidentialityLevel).toBe('Restricted');
    expect((await File.findById(f._id)).confidentiality).toBe('restricted');
    await settle();
    expect((await request(app).get(`/api/search?userId=${uid()}&q=smith`)).body.total).toBe(0);
    expect((await save(f._id, { caseNumber: 'x' })).status).toBe(404); // looks like it doesn't exist
    expect((await save(f._id, { caseNumber: 'FMLA-26-015' }, admin)).status).toBe(200);
  });

  test('handed off to the partner only once required details are complete', async () => {
    const f = await upload();
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(0);
    await save(f._id, { documentType: 'personnel.promotions', personId: 'emp-1045' }); // effectiveDate missing
    await settle();
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(0);
    await save(f._id, { effectiveDate: '2026-01-05' });
    await settle();
    const rec = await MockPartnerRecord.findOne({ kind: 'document' });
    expect(rec.payload.metadata).toMatchObject({ documentType: 'personnel.promotions', employeeId: '1045', fiscalYear: 'FY2026' });
  });

  test('"save & next" finds the next document still missing details', async () => {
    const a = await upload();
    const b = await upload();
    const next = (await request(app).get(`/api/metadata/next?userId=${uid()}&after=${a._id}`)).body;
    expect(next.fileId).toBe(String(b._id));
    await save(b._id, { documentType: 'personnel.other-official-personnel-documents', personId: 'emp-1045' });
    expect((await request(app).get(`/api/metadata/next?userId=${uid()}&after=${a._id}`)).body).toBeNull();
  });
});

describe('bulk edit', () => {
  test('preview shows the changes without saving; apply updates all 20 and logs 20 audit events', async () => {
    const files = [];
    for (let i = 0; i < 20; i++) files.push(await upload());
    const set = { documentType: 'personnel.employee-acknowledgements', personId: 'emp-1045', creationDate: '2025-10-01' };
    const preview = await request(app).post('/api/metadata/bulk').send({ userId: uid(), fileIds: files.map((f) => f._id), set });
    expect(preview.body.applied).toBe(false);
    expect(preview.body.results).toHaveLength(20);
    expect(preview.body.results[0].changes.map((c) => c.field)).toEqual(expect.arrayContaining(['documentType', 'employeeId', 'fiscalYear']));
    expect(await File.countDocuments({ metadataStatus: 'complete' })).toBe(0);

    const applied = await request(app).post('/api/metadata/bulk').send({ userId: uid(), fileIds: files.map((f) => f._id), set, apply: true });
    expect(applied.body.results.every((r) => r.metadataStatus === 'complete')).toBe(true);
    expect(await File.countDocuments({ metadataStatus: 'complete', 'metadata.fiscalYear': 'FY2026' })).toBe(20);
    expect(await AuditEvent.countDocuments({ action: 'metadata.bulk_changed' })).toBe(20);
  });
});

describe('fiscal year', () => {
  test('City fiscal year starts in July: FY2026 = Jul 2025 – Jun 2026', () => {
    expect(fiscalYearOf('2025-07-01')).toBe('FY2026');
    expect(fiscalYearOf('2026-06-30')).toBe('FY2026');
    expect(fiscalYearOf('2026-07-01')).toBe('FY2027');
    expect(fiscalYearOf('not a date')).toBeNull();
  });
});
