const fs = require('fs');
const request = require('supertest');
const { startDb, clearDb, stopDb, fixture } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const Setting = require('../../src/models/Setting');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const MockPartnerRecord = require('../../src/providers/partner/MockPartnerRecord.model');
const ClassificationOutcome = require('../../src/features/classification/ClassificationOutcome.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');

const app = createApp();
let user;
let admin;
let other; // staff member without restricted access who did not upload the document

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  user = await User.create({ email: 'hr@example.com', userName: 'hr', password: 'x' });
  admin = await User.create({ email: 'admin@example.com', userName: 'admin', password: 'x', permissions: ['admin', 'restricted'] });
  other = await User.create({ email: 'other@example.com', userName: 'other', password: 'x' });
  await Setting.create({ key: 'classification', value: { aiEnabled: true } });
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await onIdle();
    await events.idle();
  }
};
const uid = () => String(user._id);

async function upload(name, buf) {
  const c = await request(app).post('/api/uploads').send({ userId: uid(), fileName: name, sizeBytes: buf.length });
  const s = await UploadSession.findById(c.body.uploadId);
  fakes.__objects.set(s.s3Key, Buffer.from(buf));
  const done = await request(app).post(`/api/uploads/${c.body.uploadId}/complete`).send({ userId: uid() });
  await settle();
  return File.findById(done.body.file._id);
}

const answer = (over = {}) =>
  JSON.stringify({
    documentType: 'personnel.offer-letters',
    confidentialityLevel: 'Confidential',
    restrictedLikely: false,
    person: { name: 'Priya Patel', employeeId: '2087', applicantNumber: null, quote: 'Dear Priya Patel', page: 1 },
    fields: [
      { key: 'startDate', value: '2026-03-03', quote: 'starting March 3, 2026', page: 1, confidence: 0.93 },
      { key: 'salary', value: '72500', quote: 'annual salary of $72,500', page: 1, confidence: 0.95 },
      { key: 'notARealField', value: 'x', quote: null, page: null, confidence: 0.5 },
    ],
    confidence: { documentType: 0.94, person: 0.97, confidentiality: 0.9 },
    ...over,
  });
const offer = () => fs.readFileSync(fixture('offer.docx'));

describe('suggestions', () => {
  test('an offer letter gets a suggested type, person (matched by ID), details with quotes → review queue', async () => {
    fakes.__classifyReplies.push(answer());
    const f = await upload('offer.docx', offer());
    expect(f.status).toBe('needs_review');
    expect(f.reviewReasons[0]).toMatchObject({ stage: 'classification', code: 'CLASSIFICATION_REVIEW', message: 'Check the suggested details: Offer letters (94% sure)' });
    const s = f.classification.suggestion;
    expect(s.person.match).toMatchObject({ kind: 'id', personId: 'emp-2087', name: 'Priya Patel' });
    expect(s.fields.map((x) => x.key)).toEqual(['startDate', 'salary']); // unknown key dropped
    expect(s.fields[0]).toMatchObject({ quote: 'starting March 3, 2026', confidence: 0.93 });
    expect(f.metadataStatus).toBe('missing'); // nothing filed until a person accepts

    // what was sent to Claude
    const call = fakes.__anthropicCalls.find((c) => c.output_config?.format);
    expect(call).toMatchObject({ model: 'claude-opus-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(call.system[0].text).toContain('personnel.offer-letters | Personnel | Offer letters');
    expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(call.messages[0].content).toContain('[Page 1]');
    expect(call.messages[0].content).toContain('Priya Patel');

    // audit says what was suggested, never the document text
    const ev = await AuditEvent.findOne({ action: 'classification.suggested' });
    expect(ev.details).toMatchObject({ documentType: 'personnel.offer-letters', personMatch: 'id' });
    expect(JSON.stringify(ev.details)).not.toContain('72,500');

    const q = (await request(app).get(`/api/review-queue?userId=${uid()}&queue=general`)).body;
    expect(q).toEqual([expect.objectContaining({ fileId: String(f._id), documentTypeName: 'Offer letters', person: 'Priya Patel', confidence: 0.94 })]);
  });

  test('accept all: details filled, ready, handed off, accuracy recorded', async () => {
    fakes.__classifyReplies.push(answer());
    const f = await upload('offer.docx', offer());
    const r = await request(app).post(`/api/files/${f._id}/classification/accept`).send({ userId: uid() });
    expect(r.body).toMatchObject({ status: 'ready', metadataStatus: 'complete', errors: [] });
    await settle();
    const after = await File.findById(f._id);
    expect(after.metadata).toMatchObject({ documentType: 'personnel.offer-letters', employeeId: '2087', startDate: '2026-03-03', salary: 72500 });
    expect(after.classification.status).toBe('accepted');
    expect(await MockPartnerRecord.countDocuments({ kind: 'document' })).toBe(1);
    const o = await ClassificationOutcome.findOne();
    expect(o.typeCorrect).toBe(true);
    expect(o.fields.every((x) => x.accepted)).toBe(true);
    expect(await AuditEvent.countDocuments({ action: 'classification.accepted' })).toBe(1);
  });

  test('edit then accept: corrections are kept and counted as AI misses', async () => {
    fakes.__classifyReplies.push(answer());
    const f = await upload('offer.docx', offer());
    await request(app).post(`/api/files/${f._id}/classification/accept`).send({ userId: uid(), metadata: { startDate: '2026-03-10' } });
    const after = await File.findById(f._id);
    expect(after.metadata.startDate).toBe('2026-03-10');
    const o = await ClassificationOutcome.findOne();
    expect(o.fields.find((x) => x.field === 'startDate')).toMatchObject({ suggested: '2026-03-03', final: '2026-03-10', accepted: false });
    expect(o.fields.find((x) => x.field === 'salary').accepted).toBe(true);
  });

  test('"mark as reviewed" cannot skip the suggestion', async () => {
    fakes.__classifyReplies.push(answer());
    const f = await upload('offer.docx', offer());
    expect((await request(app).post(`/api/files/${f._id}/review`).send({ userId: uid() })).status).toBe(409);
  });
});

describe('person checks', () => {
  test('an ID that belongs to someone else in the directory is flagged, not trusted', async () => {
    fakes.__classifyReplies.push(answer({ person: { name: 'Maria Rivera', employeeId: '1045', applicantNumber: null, quote: 'Maria Rivera', page: 1 } }));
    const f = await upload('offer.docx', offer());
    expect(f.classification.suggestion.person.match).toMatchObject({ kind: 'id', name: 'John Smith', nameMismatch: true, nameOnDocument: 'Maria Rivera' });
    expect(f.classification.confidence.person).toBe(0.5);
    // name order / middle initials are not a mismatch
    fakes.__classifyReplies.push(answer({ person: { name: 'SMITH, John Q.', employeeId: '1045', applicantNumber: null, quote: 'x', page: 1 } }));
    const g = await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt')));
    expect(g.classification.suggestion.person.match.nameMismatch).toBeUndefined();
  });
});

describe('restricted-first routing', () => {
  test('a possibly-medical document is protected immediately, even at low confidence, and only shows in the restricted queue', async () => {
    fakes.__classifyReplies.push(
      answer({ documentType: null, confidentialityLevel: 'Confidential', restrictedLikely: true, fields: [], confidence: { documentType: 0.2, person: 0.6, confidentiality: 0.4 }, person: { name: 'John Smith', employeeId: '1045', applicantNumber: null, quote: 'John Smith', page: 1 } })
    );
    const f = await upload('note.txt', Buffer.from('Medical certification: John Smith may return to work on 12/01/2026 with restrictions.'));
    expect(f.confidentiality).toBe('restricted');
    expect(f.classification).toMatchObject({ queue: 'restricted', suggestion: { confidentialityLevel: 'Restricted', documentType: null } });
    expect(f.reviewReasons[0]).toMatchObject({ code: 'CLASSIFICATION_REVIEW_RESTRICTED', message: 'The AI could not tell the document type — choose it by hand' });

    expect((await request(app).get(`/api/review-queue?userId=${uid()}&queue=general`)).body).toEqual([]);
    expect((await request(app).get(`/api/review-queue?userId=${uid()}&queue=restricted`)).status).toBe(403);
    expect((await request(app).get(`/api/review-queue?userId=${admin._id}&queue=restricted`)).body).toHaveLength(1);
    // the uploader still finds and works on their own document…
    expect((await request(app).get(`/api/search?userId=${uid()}&q=medical`)).body.total).toBe(1);
    // …but other staff without restricted access can't even see it
    expect((await request(app).post(`/api/files/${f._id}/classification/accept`).send({ userId: String(other._id) })).status).toBe(404);
  });

  test('when the AI is unsure about confidentiality, the record goes to the restricted queue', async () => {
    fakes.__classifyReplies.push(answer({ confidence: { documentType: 0.94, person: 0.97, confidentiality: 0.45 } }));
    const f = await upload('offer.docx', offer());
    expect(f.confidentiality).toBe('restricted');
    expect(f.classification).toMatchObject({ queue: 'restricted', suggestion: { confidentialityLevel: 'Restricted' } });
  });

  test('releasing to the general queue needs restricted access', async () => {
    fakes.__classifyReplies.push(answer({ restrictedLikely: true }));
    const f = await upload('offer.docx', offer());
    expect((await request(app).post(`/api/files/${f._id}/classification/reassign`).send({ userId: String(other._id), queue: 'general' })).status).toBe(404); // can't even see it
    expect((await request(app).post(`/api/files/${f._id}/classification/reassign`).send({ userId: uid(), queue: 'general' })).status).toBe(403); // the uploader sees it, but may not release it
    const r = await request(app).post(`/api/files/${f._id}/classification/reassign`).send({ userId: String(admin._id), queue: 'general' });
    expect(r.body.queue).toBe('general');
    expect((await File.findById(f._id)).confidentiality).toBe('confidential');
    expect((await request(app).get(`/api/review-queue?userId=${uid()}&queue=general`)).body).toHaveLength(1);
  });
});

describe('failures and switches', () => {
  test('an invalid answer is retried once; the second (valid) answer is used', async () => {
    fakes.__classifyReplies.push('not json', answer());
    const f = await upload('offer.docx', offer());
    expect(f.classification.status).toBe('suggested');
  });

  test('two invalid answers, or a refusal → manual entry with a clear reason', async () => {
    fakes.__classifyReplies.push('{"documentType": 5}', 'still bad');
    const a = await upload('offer.docx', offer());
    expect(a.classification.status).toBe('failed');
    expect(a.reviewReasons[0]).toMatchObject({ code: 'CLASSIFICATION_FAILED' });
    expect(a.reviewReasons[0].message).toMatch(/enter the details by hand$/);

    fakes.__classifyReplies.push({ stop_reason: 'refusal', text: '' }, { stop_reason: 'refusal', text: '' });
    const b = await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt')));
    expect(b.reviewReasons[0].message).toMatch(/^The AI declined/);
    // a failed classification can still be completed by hand through the same accept action
    const r = await request(app).post(`/api/files/${b._id}/classification/accept`).send({ userId: uid(), metadata: { documentType: 'personnel.other-official-personnel-documents', personId: 'emp-1045' } });
    expect(r.body).toMatchObject({ status: 'ready', metadataStatus: 'complete' });
  });

  test('with AI switched off, nothing is sent to the AI and documents go straight to manual entry', async () => {
    const put = await request(app).put('/api/settings/classification').send({ userId: String(admin._id), settings: { aiEnabled: false } });
    expect(put.body.aiEnabled).toBe(false);
    const f = await upload('offer.docx', offer());
    expect(f.status).toBe('ready');
    expect(f.classification.status).toBe('disabled');
    expect(fakes.__anthropicCalls.filter((c) => c.output_config?.format)).toHaveLength(0);
  });

  test('auto-accept (admin opt-in) files only very confident suggestions with an exact person match', async () => {
    await request(app).put('/api/settings/classification').send({ userId: String(admin._id), settings: { autoAccept: true, autoAcceptThreshold: 0.9 } });
    fakes.__classifyReplies.push(answer());
    const sure = await upload('offer.docx', offer());
    expect(sure.status).toBe('ready');
    expect(sure.classification.status).toBe('auto_accepted');
    expect(sure.metadataStatus).toBe('complete');
    expect(await AuditEvent.countDocuments({ action: 'metadata.auto_filled' })).toBe(1);

    fakes.__classifyReplies.push(answer({ confidence: { documentType: 0.7, person: 0.97, confidentiality: 0.9 } }));
    const unsure = await upload('evaluation.txt', fs.readFileSync(fixture('evaluation.txt')));
    expect(unsure.status).toBe('needs_review');

    // restricted records are never filed without a person, however confident
    fakes.__classifyReplies.push(answer({ restrictedLikely: true, confidence: { documentType: 0.99, person: 0.99, confidentiality: 0.99 } }));
    const restricted = await upload('fmla.txt', Buffer.from('FMLA certification for Priya Patel, employee 2087. Leave from 01/05/2027.'));
    expect(restricted.status).toBe('needs_review');
    expect(restricted.classification).toMatchObject({ status: 'suggested', queue: 'restricted' });
  });

  test('settings are admin-only and validated', async () => {
    expect((await request(app).put('/api/settings/classification').send({ userId: uid(), settings: { aiEnabled: false } })).status).toBe(403);
    expect((await request(app).put('/api/settings/classification').send({ userId: String(admin._id), settings: { autoAcceptThreshold: 0.2 } })).status).toBe(400);
  });
});

describe('accuracy', () => {
  test('acceptance rate by document type', async () => {
    fakes.__classifyReplies.push(answer(), answer());
    const a = await upload('offer.docx', offer());
    const b = await upload('offer2.docx', Buffer.concat([offer()])); // exact duplicate flagged too — accept still works
    await request(app).post(`/api/files/${a._id}/classification/accept`).send({ userId: uid() });
    await request(app).post(`/api/files/${b._id}/classification/accept`).send({ userId: uid(), metadata: { documentType: 'recruitment.offer-documentation' } });
    expect((await request(app).get(`/api/classification/accuracy?userId=${uid()}`)).status).toBe(403);
    const rows = (await request(app).get(`/api/classification/accuracy?userId=${admin._id}`)).body;
    expect(rows.find((r) => r.documentType === 'personnel.offer-letters')).toMatchObject({ documents: 1, typeAcceptance: 1, fieldAcceptance: 1 });
    expect(rows.find((r) => r.documentType === 'recruitment.offer-documentation')).toMatchObject({ documents: 1, typeAcceptance: 0 });
  });
});
