const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const MailComposer = require('nodemailer/lib/mail-composer');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { startDb, clearDb, stopDb } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const intake = require('../../src/features/emailintake/service');
const { setEmailSource } = require('../../src/features/emailintake/sources');
const { localSource } = require('../../src/features/emailintake/sources/local');
const { graphSource } = require('../../src/features/emailintake/sources/graph');
const { extractHints } = require('../../src/features/emailintake/hints');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const Setting = require('../../src/models/Setting');
const SearchDoc = require('../../src/models/SearchDoc');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');
const EmailIntakeLog = require('../../src/features/emailintake/EmailIntakeLog.model');

const app = createApp();
let user;
let admin;
let dir;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-'));
  setEmailSource(localSource(dir));
  user = await User.create({ email: 'intake@example.com', userName: 'intake', password: 'x', permissions: ['restricted'] });
  admin = await User.create({ email: 'admin@example.com', userName: 'admin', password: 'x', permissions: ['admin'] });
});
afterEach(() => {
  jest.restoreAllMocks();
  setEmailSource(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await onIdle();
    await events.idle();
  }
};
const aid = () => String(admin._id);
const configure = (over = {}) =>
  request(app)
    .put('/api/email-intake')
    .send({ userId: aid(), settings: { allowList: 'portsmouthva.gov, partner@benefits.example', ownerEmail: 'intake@example.com', ...over } });

async function pdfBytes(text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 10, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
const eml = (opts) => new Promise((res, rej) => new MailComposer(opts).compile().build((e, m) => (e ? rej(e) : res(m))));
const drop = async (name, opts) => fs.writeFileSync(path.join(dir, name), await eml(opts));
const longText = (s) => `${s} This is a filler sentence for the City of Portsmouth personnel records office.`;

describe('email intake (local mailbox folder)', () => {
  test('3 messages: linked documents from an allowed sender, one rejected sender, one forwarded duplicate skipped', async () => {
    await configure();
    const w4 = await pdfBytes(longText('W-4 Employee Withholding Certificate for John Smith, Employee ID 1045.'));
    await drop('1-hr.eml', {
      from: 'Pat HR <pat.jones@portsmouthva.gov>',
      to: 'hr-intake@portsmouthva.gov',
      subject: 'New hire paperwork for John Smith (ID 1045)',
      messageId: '<msg-1@portsmouthva.gov>',
      text: 'Hello, attached are the signed W-4 and the direct deposit form for John Smith, employee ID 1045, who starts on March 3. Please file them in his personnel record. Thanks, Pat\n-- \nPat Jones | HR Generalist',
      attachments: [
        { filename: 'w4-smith.pdf', content: w4 },
        { filename: 'direct-deposit.txt', content: longText('Direct deposit authorization for John Smith, routing 0000, account ending 1234.') },
        { filename: 'logo.png', content: Buffer.from('89504e470d0a1a0a', 'hex'), cid: 'logo@sig', contentDisposition: 'inline' },
      ],
    });
    await drop('2-spam.eml', {
      from: 'Prize Desk <winner@lottery.example>',
      to: 'hr-intake@portsmouthva.gov',
      subject: 'You won',
      messageId: '<spam-1@lottery.example>',
      text: 'Click here',
      attachments: [{ filename: 'invoice.pdf', content: w4 }],
    });
    await drop('3-fwd.eml', {
      from: 'Benefits Partner <partner@benefits.example>',
      to: 'hr-intake@portsmouthva.gov',
      subject: 'Fwd: New hire paperwork for John Smith (ID 1045)',
      messageId: '<msg-2@benefits.example>',
      text: 'FYI\n\n---------- Forwarded message ---------\n> attached',
      attachments: [{ filename: 'w4-smith.pdf', content: w4 }],
    });

    const r = await request(app).post('/api/email-intake/poll').send({ userId: aid() });
    expect(r.body).toMatchObject({ imported: 2, rejected: 1, duplicate: 0, failed: 0 });
    await settle();

    // 1: the email + its 2 real attachments (the inline signature logo is not a document)
    const mail1 = await File.findOne({ fileName: 'New hire paperwork for John Smith (ID 1045).eml' });
    expect(mail1).toMatchObject({ source: 'email', containerOnly: false, userId: user._id });
    const kids = await File.find({ parentDocumentId: mail1._id }).sort({ fileName: 1 });
    expect(kids.map((k) => k.fileName)).toContain('direct-deposit.txt');
    expect(kids.every((k) => k.source === 'email' && ['ready', 'needs_review'].includes(k.status))).toBe(true);
    expect(kids[0].metadata.intakeHints).toMatchObject({ employeeIds: ['1045'], keywords: expect.arrayContaining(['W-4', 'direct deposit']) });
    expect(mail1.rawText).toMatch(/signed W-4 and the direct deposit form/);

    // 2: rejected sender → Rejected folder + log, nothing stored
    expect(fs.existsSync(path.join(dir, 'Rejected', '2-spam.eml'))).toBe(true);
    expect(await File.exists({ fileName: /You won/ })).toBeNull();
    const rej = await EmailIntakeLog.findOne({ status: 'rejected' }).lean();
    expect(rej).toMatchObject({ from: 'winner@lottery.example', reason: 'Sender is not on the allow-list', messageId: '<spam-1@lottery.example>' });

    // 3: forwarded copy — the same W-4 is stored once (linked to whichever email was processed
    // first; both run in parallel) and skipped in the other; "FYI" body is not filed on its own
    const mail3 = await File.findOne({ fileName: /^Fwd/ });
    expect(mail3.containerOnly).toBe(true);
    expect(await File.countDocuments({ fileName: 'w4-smith.pdf' })).toBe(1);
    const w4doc = await File.findOne({ fileName: 'w4-smith.pdf' });
    expect([String(mail1._id), String(mail3._id)]).toContain(String(w4doc.parentDocumentId));
    const loser = String(w4doc.parentDocumentId) === String(mail1._id) ? mail3 : await File.findById(mail1._id);
    expect(loser.childSummary.skipped).toEqual([{ name: 'w4-smith.pdf', reason: expect.stringMatching(/^Already captured — /) }]);
    // a container is not searched, classified or handed off by itself
    expect(await SearchDoc.exists({ fileId: mail3._id })).toBeNull();
    expect(mail3.status).toBe('ready');

    expect(fs.readdirSync(path.join(dir, 'Processed')).sort()).toEqual(['1-hr.eml', '3-fwd.eml']);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.eml'))).toEqual([]);

    // audit: sender, subject hash, message id — never the body
    const a = await AuditEvent.findOne({ action: 'email.imported', documentId: mail1._id }).lean();
    expect(a.details).toMatchObject({ from: 'pat.jones@portsmouthva.gov', messageId: '<msg-1@portsmouthva.gov>', attachments: 2, bodyFiled: true });
    expect(a.details.subjectHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(a.details)).not.toMatch(/John Smith|W-4/);
    expect(await AuditEvent.countDocuments({ action: 'email.rejected' })).toBe(1);
  });

  test('two different emails with the same attachment in one poll store it once', async () => {
    await configure();
    const pdf = await pdfBytes(longText('I-9 Employment Eligibility Verification for Carlos Rivera, Employee ID 3310.'));
    const msg = (n) => ({ from: `clerk${n}@portsmouthva.gov`, subject: `I-9 copy ${n}`, messageId: `<i9-${n}@portsmouthva.gov>`, text: 'See attached.', attachments: [{ filename: 'i9.pdf', content: pdf }] });
    await drop('a.eml', msg(1));
    await drop('b.eml', msg(2));
    expect((await intake.pollOnce()).imported).toBe(2);
    await settle();
    expect(await File.countDocuments({ fileName: 'i9.pdf' })).toBe(1);
    const skipped = (await File.find({ source: 'email', parentDocumentId: null }).lean()).flatMap((f) => f.childSummary.skipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/^Already captured/);
  });

  test('the same message again is skipped (Message-ID), and logged as a duplicate', async () => {
    await configure();
    const msg = { from: 'pat.jones@portsmouthva.gov', subject: 'Resignation letter', messageId: '<same@portsmouthva.gov>', text: longText('Please find my resignation letter below, effective two weeks from today, with thanks for everything.') };
    await drop('a.eml', msg);
    await intake.pollOnce();
    await drop('b.eml', msg);
    const r = await intake.pollOnce();
    expect(r).toMatchObject({ imported: 0, duplicate: 1 });
    expect(await File.countDocuments({ source: 'email' })).toBe(1);
    expect(await EmailIntakeLog.countDocuments({ status: 'duplicate' })).toBe(1);
  });

  test('forged senders (DMARC fail) and an empty allow-list are rejected', async () => {
    await configure({ allowList: '' });
    await drop('x.eml', { from: 'pat.jones@portsmouthva.gov', subject: 'Hi', messageId: '<x@y>', text: 'x' });
    expect((await intake.pollOnce()).rejected).toBe(1);
    expect((await EmailIntakeLog.findOne({}).lean()).reason).toMatch(/allow-list is empty/);

    await configure();
    await drop('forged.eml', {
      from: 'pat.jones@portsmouthva.gov',
      subject: 'Payroll change',
      messageId: '<forged@evil>',
      headers: { 'Authentication-Results': 'mx.portsmouthva.gov; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=portsmouthva.gov' },
      text: 'Change my bank account',
    });
    await intake.pollOnce();
    expect((await EmailIntakeLog.findOne({ messageId: '<forged@evil>' }).lean()).reason).toBe('The sender could not be verified (DMARC failed)');
  });

  test('hints reach the classifier as unverified context; an FMLA email is protected straight away', async () => {
    await Setting.create({ key: 'classification', value: { aiEnabled: true } });
    await configure();
    fakes.__classifyReplies.push(
      JSON.stringify({ documentType: null, confidentialityLevel: 'Confidential', restrictedLikely: false, person: { name: null, employeeId: null, applicantNumber: null, quote: null, page: null }, fields: [], confidence: { documentType: 0.3, person: 0.3, confidentiality: 0.9 } })
    );
    await drop('fmla.eml', {
      from: 'pat.jones@portsmouthva.gov',
      subject: 'FMLA certification - employee ID 2087',
      messageId: '<fmla@portsmouthva.gov>',
      text: 'See attached.',
      attachments: [{ filename: 'cert.pdf', content: await pdfBytes(longText('Certification of health care provider for the employee.')) }],
    });
    await intake.pollOnce();
    await settle();
    const cert = await File.findOne({ fileName: 'cert.pdf' });
    expect(cert.confidentiality).toBe('restricted');
    expect(cert.classification.queue).toBe('restricted');
    const call = fakes.__anthropicCalls.find((c) => c.output_config && c.output_config.format);
    expect(call.messages[0].content).toMatch(/<email_hints>\nEmail subject: FMLA certification - employee ID 2087\nEmployee ID\(s\) mentioned in the email: 2087/);
    expect(call.messages[0].content).toMatch(/may be wrong/);
    // hints are never written into the record as facts
    expect(cert.metadata.personId).toBeUndefined();
  });

  test('settings are admin-only and validated; intake waits until an owner is chosen', async () => {
    expect((await request(app).put('/api/email-intake').send({ userId: String(user._id), settings: { allowList: 'a.gov' } })).status).toBe(403);
    expect((await configure({ allowList: 'not a domain!' })).body.message).toMatch(/Not an address or domain/);
    expect((await configure({ ownerEmail: 'nobody@example.com' })).body.message).toMatch(/owns e-mailed documents/);
    expect((await intake.pollOnce()).errors).toEqual(['Choose who owns e-mailed documents first']);
    const ok = await configure({ importBody: 'never' });
    expect(ok.body).toMatchObject({ allowList: ['portsmouthva.gov', 'partner@benefits.example'], importBody: 'never', ownerEmail: 'intake@example.com' });
    expect((await request(app).get(`/api/email-intake?userId=${aid()}`)).body).toMatchObject({ settings: { importBody: 'never' } });
  });
});

describe('unit', () => {
  test('allow-list matching and hint extraction', () => {
    expect(intake.senderAllowed('a@hr.portsmouthva.gov', ['portsmouthva.gov'])).toBe(true);
    expect(intake.senderAllowed('a@portsmouthva.gov.evil.com', ['portsmouthva.gov'])).toBe(false);
    expect(intake.senderAllowed('partner@benefits.example', ['partner@benefits.example'])).toBe(true);
    expect(intake.senderAllowed('other@benefits.example', ['partner@benefits.example'])).toBe(false);
    expect(extractHints('Offer letter – Emp# 3310', 'Workers comp claim attached')).toMatchObject({ employeeIds: ['3310'], keywords: ['offer letter'], restricted: true });
    expect(intake.meaningfulBody('Thanks!\n-- \nPat Jones, HR Generalist, City of Portsmouth, 801 Crawford St, Portsmouth VA', 80)).toBe(false);
  });

  test('Microsoft Graph source: token, list, fetch MIME, move to Processed (creating the folder once)', async () => {
    const calls = [];
    const http = {
      post: jest.fn(async (url, body) => {
        calls.push(['POST', url]);
        expect(body).toMatch(/grant_type=client_credentials/);
        expect(body).toMatch(/scope=https%3A%2F%2Fgraph.microsoft.com%2F.default/);
        return { data: { access_token: 'tok', expires_in: 3600 } };
      }),
      request: jest.fn(async ({ method, url, headers, data }) => {
        calls.push([method.toUpperCase(), url.replace('https://graph.microsoft.com/v1.0', ''), data]);
        expect(headers.Authorization).toBe('Bearer tok');
        if (url.includes('/mailFolders/inbox/messages')) return { data: { value: [{ id: 'AAA', receivedDateTime: '2026-11-21T10:00:00Z', internetMessageId: '<m@x>' }] } };
        if (url.endsWith('/$value')) return { data: Buffer.from('From: a@b.c\r\nSubject: hi\r\n\r\nbody') };
        if (url.includes('childFolders?$filter')) return { data: { value: [] } };
        if (url.endsWith('/childFolders')) return { data: { id: 'FOLDER-P' } };
        return { data: {} };
      }),
    };
    const src = graphSource({ tenantId: 'tenant-1', clientId: 'app-1', clientSecret: 's3cret', mailbox: 'hr-intake@portsmouthva.gov' }, http);
    expect(await src.list(10)).toEqual([{ id: 'AAA', receivedAt: new Date('2026-11-21T10:00:00Z'), messageId: '<m@x>' }]);
    expect((await src.fetch('AAA')).raw.toString()).toMatch(/Subject: hi/);
    await src.markProcessed('AAA');
    await src.markProcessed('AAA');
    expect(calls[0]).toEqual(['POST', 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token']);
    expect(http.post).toHaveBeenCalledTimes(1); // token reused
    expect(calls.filter((c) => c[1].endsWith('/childFolders'))).toHaveLength(1); // folder created once
    expect(calls).toContainEqual(['POST', '/users/hr-intake%40portsmouthva.gov/messages/AAA/move', { destinationId: 'FOLDER-P' }]);
    expect(() => graphSource({ tenantId: 't' })).toThrow(/GRAPH_CLIENT_ID/);
  });
});
