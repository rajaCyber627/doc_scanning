const request = require('supertest');
const Jimp = require('jimp');
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { startDb, clearDb, stopDb } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const Setting = require('../../src/models/Setting');
const SearchDoc = require('../../src/models/SearchDoc');
const OcrPage = require('../../src/features/ocr/OcrPage.model');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const UploadSession = require('../../src/features/upload/UploadSession.model');
const separators = require('../../src/features/splitting/separators');
const { validatePlan } = require('../../src/features/splitting/service');
const { pdfPageTexts } = require('../../src/features/splitting/pages');

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
});
afterEach(() => jest.restoreAllMocks());

const settle = async () => {
  for (let i = 0; i < 6; i++) {
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

// ---------------------------------------------------------------- fixtures
const filler = (seed) =>
  `This page continues the ${seed} with the terms, conditions and signatures that the City of Portsmouth Human Resources department requires for the record.`;

/** A digital PDF; each entry is a page: string (text), { jpeg } (a scanned image page). */
async function pdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([612, 792]);
    if (typeof p === 'string') {
      p.split('\n').forEach((line, i) => page.drawText(line, { x: 50, y: 740 - i * 16, size: 10, font }));
    } else {
      const img = await doc.embedJpg(p.jpeg);
      page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A "scanned" separator sheet: a white page with a QR code (no text layer). */
async function qrSheetJpeg(code) {
  const qr = QRCode.create(code, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const mod = 12;
  const img = new Jimp(850, 1100, 0xffffffff);
  const x0 = Math.floor((850 - n * mod) / 2);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.modules.get(r, c)) img.scan(x0 + c * mod, 300 + r * mod, mod, mod, function paint(x, y, idx) {
        this.bitmap.data[idx] = this.bitmap.data[idx + 1] = this.bitmap.data[idx + 2] = 0;
      });
  return img.quality(85).getBufferAsync(Jimp.MIME_JPEG);
}

const offerPages = [
  'OFFER OF EMPLOYMENT\nDear Priya Patel (Employee ID 2087),\nWe are pleased to offer you the position of HR Analyst starting March 3, 2026.\nPage 1 of 3',
  `${filler('offer letter')}\nPage 2 of 3`,
  `${filler('offer letter')}\nSigned and accepted by Priya Patel. Page 3 of 3`,
];
const electionPages = [
  'BENEFIT ELECTION FORM 2026\nEmployee: John Smith  Employee ID 1045\nMedical plan: PPO  Dental: Basic  Plan year 2026\nPage 1 of 3',
  `${filler('benefit election form')}\nPage 2 of 3`,
  `${filler('benefit election form')}\nDependents listed above. Page 3 of 3`,
];
const ackPages = [
  'EMPLOYEE HANDBOOK ACKNOWLEDGEMENT\nI, Maria Rivera (Employee ID 3310), acknowledge receipt of the employee handbook.\nPage 1 of 4',
  `${filler('handbook acknowledgement')}\nPage 2 of 4`,
  `${filler('handbook acknowledgement')}\nPage 3 of 4`,
  `${filler('handbook acknowledgement')}\nSignature: Maria Rivera. Page 4 of 4`,
];
const bundle = () => pdf([...offerPages, ...electionPages, ...ackPages]);

const classifyAnswer = (documentType, name, employeeId) =>
  JSON.stringify({
    documentType,
    confidentialityLevel: 'Confidential',
    restrictedLikely: false,
    person: { name, employeeId, applicantNumber: null, quote: name, page: 1 },
    fields: [],
    confidence: { documentType: 0.9, person: 0.9, confidentiality: 0.9 },
  });

// ---------------------------------------------------------------- tests
describe('pages and plans', () => {
  test('per-page text of a PDF and the page list for the page view', async () => {
    const buf = await bundle();
    const texts = await pdfPageTexts(buf);
    expect(texts).toHaveLength(10);
    expect(texts[3]).toMatch(/BENEFIT ELECTION FORM 2026/);

    const f = await upload('folder-scan.pdf', buf);
    expect(f.status).toBe('ready');
    expect(f.splitInto).toHaveLength(0); // no separators → not split automatically
    const r = await request(app).get(`/api/files/${f._id}/pages?userId=${uid()}`);
    expect(r.body).toMatchObject({ pageCount: 10, source: 'original', splittable: true });
    expect(r.body.pages[6].snippet).toMatch(/^EMPLOYEE HANDBOOK ACKNOWLEDGEMENT/);
    const pdfRes = await request(app).get(`/api/files/${f._id}/pages.pdf?userId=${uid()}`);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
  });

  test('a plan must cover every page exactly once (or remove it)', () => {
    expect(() => validatePlan({ parts: [{ from: 1, to: 3 }] }, 5)).toThrow('Pages 4, 5 are not in any part');
    expect(() => validatePlan({ parts: [{ from: 1, to: 3 }, { from: 3, to: 5 }] }, 5)).toThrow('Page 3 is in more than one part');
    expect(() => validatePlan({ parts: [{ from: 1, to: 1 }, { from: 2, to: 5 }], removed: [1] }, 5)).toThrow('Part 1 has no pages left');
    expect(() => validatePlan({ parts: [{ from: 0, to: 2 }] }, 5)).toThrow('invalid page range');
    const ok = validatePlan({ parts: [{ from: 1, to: 2 }, { from: 4, to: 5 }], removed: [3], rotations: { 4: 90, 2: 45 } }, 5);
    expect(ok.parts.map((p) => p.pages)).toEqual([[1, 2], [4, 5]]);
    expect(ok.rotations).toEqual({ 4: 90 });
  });
});

describe('AI-suggested split', () => {
  test('a 10-page file with 3 forms → 3 documents, each classified on its own; the original stays', async () => {
    await Setting.create({ key: 'classification', value: { aiEnabled: true } });
    // the bundle itself is classified once on upload
    fakes.__classifyReplies.push(classifyAnswer('personnel.offer-letters', 'Priya Patel', '2087'));
    const f = await upload('folder-scan.pdf', await bundle());

    fakes.__classifyReplies.push(
      JSON.stringify({
        documents: [
          { startPage: 1, documentType: 'personnel.offer-letters', reason: "Page 1 starts 'OFFER OF EMPLOYMENT'", confidence: 0.95 },
          { startPage: 4, documentType: 'benefits.benefit-elections', reason: "Page 4 starts a new form: 'BENEFIT ELECTION FORM 2026'", confidence: 0.93 },
          { startPage: 7, documentType: 'personnel.employee-acknowledgements', reason: "Page 7 starts 'EMPLOYEE HANDBOOK ACKNOWLEDGEMENT'", confidence: 0.9 },
          { startPage: 99, documentType: 'nonsense', reason: 'out of range', confidence: 0.1 },
        ],
      })
    );
    const s = await request(app).post(`/api/files/${f._id}/split/suggest`).send({ userId: uid() });
    expect(s.status).toBe(200);
    expect(s.body.cuts).toEqual([
      { page: 4, reason: "Page 4 starts a new form: 'BENEFIT ELECTION FORM 2026'", confidence: 0.93 },
      { page: 7, reason: "Page 7 starts 'EMPLOYEE HANDBOOK ACKNOWLEDGEMENT'", confidence: 0.9 },
    ]);
    expect(s.body.parts.map((p) => [p.from, p.to, p.documentType])).toEqual([
      [1, 3, 'personnel.offer-letters'],
      [4, 6, 'benefits.benefit-elections'],
      [7, 10, 'personnel.employee-acknowledgements'],
    ]);
    // the suggestion is kept for the page view
    expect((await request(app).get(`/api/files/${f._id}/pages?userId=${uid()}`)).body.suggestion.cuts).toHaveLength(2);

    // accept: each part is classified separately
    fakes.__classifyReplies.push(
      classifyAnswer('personnel.offer-letters', 'Priya Patel', '2087'),
      classifyAnswer('benefits.benefit-elections', 'John Smith', '1045'),
      classifyAnswer('personnel.employee-acknowledgements', 'Maria Rivera', '3310')
    );
    const before = fakes.__anthropicCalls.length;
    const r = await request(app)
      .post(`/api/files/${f._id}/split`)
      .send({ userId: uid(), via: 'ai', parts: s.body.parts.map((p) => ({ from: p.from, to: p.to, documentType: p.documentType })) });
    expect(r.status).toBe(200);
    expect(r.body.parts.map((p) => p.pages)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9, 10]]);
    await settle();

    const kids = await File.find({ parentDocumentId: f._id }).sort({ 'splitFrom.part': 1 });
    expect(kids.map((k) => k.fileName)).toEqual([
      'folder-scan - part 1 (Offer letters).pdf',
      'folder-scan - part 2 (Benefit elections).pdf',
      'folder-scan - part 3 (Employee acknowledgements).pdf',
    ]);
    expect(kids.map((k) => k.pageCount)).toEqual([3, 3, 4]);
    for (const k of kids) {
      expect(k.status).toBe('needs_review'); // the AI suggestion waits for a person
      expect(k.derivedFrom.map(String)).toEqual([String(f._id)]);
      expect(k.duplicateOf).toEqual([]); // never a "duplicate" of its own original
    }
    // parts are processed in parallel, so the fake AI's answers may land in any order
    expect(kids.map((k) => k.classification.suggestion.documentType).sort()).toEqual(['benefits.benefit-elections', 'personnel.employee-acknowledgements', 'personnel.offer-letters']);
    // each part was sent to the AI on its own, with only its own pages
    const sent = fakes.__anthropicCalls.slice(before).filter((c) => c.output_config?.format).map((c) => c.messages[0].content);
    expect(sent).toHaveLength(3);
    const election = sent.filter((t) => /BENEFIT ELECTION FORM/.test(t));
    expect(election).toHaveLength(1);
    expect(election[0]).not.toMatch(/OFFER OF EMPLOYMENT|HANDBOOK/);
    expect(election[0]).toMatch(/^\[Page 1\]\nBENEFIT/m); // renumbered from page 4

    // the original is preserved and linked, but left search
    const orig = await File.findById(f._id);
    expect(orig.status).toBe('ready');
    expect(orig.splitInto.map(String)).toEqual(kids.map((k) => String(k._id)));
    expect(orig.reviewReasons).toEqual([]);
    expect(fakes.__objects.has(orig.s3Key)).toBe(true);
    expect(await SearchDoc.exists({ fileId: f._id })).toBeNull();
    expect((await request(app).get(`/api/files/${f._id}`)).status).toBe(200);

    const audit = await AuditEvent.findOne({ action: 'document.split' }).lean();
    expect(audit.details).toMatchObject({ via: 'ai', pageCount: 10, removedPages: [] });
    expect(audit.details.parts.map((p) => p.pages)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9, 10]]);

    const lin = (await request(app).get(`/api/files/${f._id}/lineage?userId=${uid()}`)).body;
    expect(lin.splitInto.map((x) => x.pages)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9, 10]]);
    const back = (await request(app).get(`/api/files/${kids[1]._id}/lineage?userId=${uid()}`)).body;
    expect(back.splitFrom).toMatchObject({ fileId: String(f._id), fileName: 'folder-scan.pdf', part: 2, pages: [4, 5, 6] });

    // splitting twice is refused
    expect((await request(app).post(`/api/files/${f._id}/split`).send({ userId: uid(), parts: [{ from: 1, to: 10 }] })).status).toBe(409);
  });

  test('suggestions need the AI switched on', async () => {
    const f = await upload('folder-scan.pdf', await bundle());
    const r = await request(app).post(`/api/files/${f._id}/split/suggest`).send({ userId: uid() });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Place the cuts by hand/);
  });
});

describe('manual split', () => {
  test('cuts, a rotated page and a removed blank page; chosen type pre-fills the details', async () => {
    const f = await upload('two.pdf', await pdf([...offerPages, '', ...electionPages]));
    const r = await request(app)
      .post(`/api/files/${f._id}/split`)
      .send({
        userId: uid(),
        parts: [
          { from: 1, to: 4, name: 'Patel offer' },
          { from: 5, to: 7, documentType: 'benefits.benefit-elections', employeeId: '1045' },
        ],
        removed: [4],
        rotations: { 6: 90 },
      });
    expect(r.body).toEqual(expect.objectContaining({ parts: expect.any(Array) }));
    expect(r.status).toBe(200);
    await settle();
    const [a, b] = await File.find({ parentDocumentId: f._id }).sort({ 'splitFrom.part': 1 });
    expect(a.fileName).toBe('Patel offer.pdf');
    expect(a.splitFrom.pages).toEqual([1, 2, 3]);
    const bPdf = await PDFDocument.load(fakes.__objects.get(b.s3Key));
    expect(bPdf.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 0]);
    // AI is off, but the chosen type and employee become the suggestion to confirm
    expect(b.classification).toMatchObject({ status: 'suggested', model: 'separator-sheet' });
    expect(b.classification.suggestion).toMatchObject({ documentType: 'benefits.benefit-elections', person: { match: { kind: 'id', name: 'John Smith' } } });
    const audit = await AuditEvent.findOne({ action: 'document.split' }).lean();
    expect(audit.details).toMatchObject({ via: 'manual', removedPages: [4], rotatedPages: [6] });
  });

  test('a restricted original is hidden from other staff, and its parts stay restricted', async () => {
    const f = await upload('medical.pdf', await pdf([...offerPages, ...electionPages]));
    await File.updateOne({ _id: f._id }, { confidentiality: 'restricted' });
    const parts = [{ from: 1, to: 3 }, { from: 4, to: 6 }];
    expect((await request(app).post(`/api/files/${f._id}/split`).send({ userId: String(other._id), parts })).status).toBe(404); // other staff can't see it
    expect((await request(app).post(`/api/files/${f._id}/split`).send({ userId: String(admin._id), parts })).status).toBe(200);
    await settle();
    const kids = await File.find({ parentDocumentId: f._id });
    expect(kids.map((k) => k.confidentiality)).toEqual(['restricted', 'restricted']);
  });

  test('an OCR\'d scan: parts reuse the OCR of their pages (no second OCR run)', async () => {
    const page = await new Jimp(400, 500, 0xffffffff).quality(80).getBufferAsync(Jimp.MIME_JPEG);
    const buf = await pdf([{ jpeg: page }, { jpeg: page }, { jpeg: page }]);
    const key = `uploads/${uid()}/scan.pdf`;
    fakes.__objects.set(key, buf);
    const f = await File.create({ userId: user._id, fileName: 'scan.pdf', s3Key: key, mimeType: 'application/pdf', status: 'ready', pageCount: 3 });
    await OcrPage.insertMany(
      ['W-4 Employee Withholding Certificate John Smith', 'second page of the W-4', 'Direct deposit authorization John Smith'].map((text, i) => ({
        fileId: f._id,
        page: i + 1,
        text,
        confidence: 97,
        words: [{ t: 'x', c: 97, x: 0.1, y: 0.1, w: 0.1, h: 0.02 }],
      }))
    );
    const calls = fakes.__textract.calls.length;
    const r = await request(app).post(`/api/files/${f._id}/split`).send({ userId: uid(), parts: [{ from: 1, to: 2 }, { from: 3, to: 3 }] });
    expect(r.status).toBe(200);
    await settle();
    const [a, b] = await File.find({ parentDocumentId: f._id }).sort({ 'splitFrom.part': 1 });
    expect(a.rawText).toBe('W-4 Employee Withholding Certificate John Smith\n\nsecond page of the W-4');
    expect(b.rawText).toBe('Direct deposit authorization John Smith');
    expect(a.ocr).toMatchObject({ provider: 'split', pages: 2, avgConfidence: 97 });
    expect(await OcrPage.countDocuments({ fileId: b._id })).toBe(1);
    expect(fakes.__textract.calls.length).toBe(calls);
  });
});

describe('separator sheets', () => {
  test('the code is read back from text', () => {
    expect(separators.parse('blah DOCP-SEP:v1;type=benefits.benefit-elections;emp=1045 blah')).toEqual({ documentType: 'benefits.benefit-elections', employeeId: '1045' });
    expect(separators.parse('DOCP SEP: v1')).toEqual({});
    expect(separators.parse('an ordinary page')).toBeNull();
    expect(separators.partsFromSeparators(7, [{ page: 1, prefill: { employeeId: '9' } }, { page: 4, prefill: {} }])).toEqual([
      { from: 2, to: 3, prefill: { employeeId: '9' } },
      { from: 5, to: 7, prefill: {} },
    ]);
  });

  test('QR separator pages split a file automatically and are dropped; the sheet pre-fills the details', async () => {
    const qr = await qrSheetJpeg(separators.encode({ documentType: 'benefits.benefit-elections', employeeId: '1045' }));
    const qrPlain = await qrSheetJpeg(separators.encode({}));
    const buf = await pdf([
      ...offerPages.slice(0, 2),
      { jpeg: qr },
      ...electionPages.slice(0, 2),
      { jpeg: qrPlain },
      ackPages[0],
      // a printed sheet whose code is read from the text layer
      `SEPARATOR SHEET\n${separators.encode({ documentType: 'personnel.offer-letters' })}`,
      offerPages[0],
    ]);
    const f = await upload('batch.pdf', buf);
    await settle();

    const orig = await File.findById(f._id);
    expect(orig.status).toBe('ready');
    expect(orig.splitInto).toHaveLength(4);
    const kids = await File.find({ parentDocumentId: f._id }).sort({ 'splitFrom.part': 1 });
    expect(kids.map((k) => k.splitFrom.pages)).toEqual([[1, 2], [4, 5], [7], [9]]);
    expect(kids.map((k) => k.splitFrom.via)).toEqual(['separator', 'separator', 'separator', 'separator']);
    expect(kids[1].classification.suggestion).toMatchObject({ documentType: 'benefits.benefit-elections', person: { match: { kind: 'id', personId: 'emp-1045' } } });
    expect(kids[3].classification.suggestion.documentType).toBe('personnel.offer-letters');
    expect(kids.every((k) => ['ready', 'needs_review'].includes(k.status))).toBe(true);
    const audit = await AuditEvent.findOne({ action: 'document.split' }).lean();
    expect(audit.details).toMatchObject({ via: 'separator', removedPages: [3, 6, 8] });
  });

  test('blank-page-as-separator mode (admin setting)', async () => {
    const buf = await pdf([offerPages[0], offerPages[1], '', electionPages[0], electionPages[1]]);
    expect((await upload('a.pdf', buf)).splitInto).toHaveLength(0); // off by default
    expect((await request(app).put('/api/settings/splitting').send({ userId: uid(), settings: { blankIsSeparator: true } })).status).toBe(403);
    await request(app).put('/api/settings/splitting').send({ userId: String(admin._id), settings: { blankIsSeparator: true } });
    const f = await upload('b.pdf', Buffer.concat([buf, Buffer.from('\n% second copy\n')]));
    expect(f.splitInto).toHaveLength(2);
  });

  test('printable separator sheet carries the code as QR and as text', async () => {
    const r = await request(app).get('/api/separator-sheet.pdf?documentType=benefits.benefit-elections&employeeId=1045').buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    const [text] = await pdfPageTexts(r.body);
    expect(separators.parse(text)).toEqual({ documentType: 'benefits.benefit-elections', employeeId: '1045' });
    expect(text).toMatch(/Benefit elections/);
    expect((await request(app).get('/api/separator-sheet.pdf?documentType=nope')).status).toBe(400);
  });
});
