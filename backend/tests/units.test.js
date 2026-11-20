jest.mock('../src/clients', () => require('./fakes/clients'));

const { startDb, clearDb, stopDb } = require('./helpers');
const { InProcessQueue } = require('../src/pipeline/queue');
const { humanizeError } = require('../src/pipeline/errors');
const { getPartner } = require('../src/partner');

describe('InProcessQueue', () => {
  test('never runs more than the concurrency limit and reports idle', async () => {
    const q = new InProcessQueue({ concurrency: 2 });
    let running = 0;
    let peak = 0;
    const job = () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };
    for (let i = 0; i < 6; i++) q.add(job());
    await q.onIdle();
    expect(peak).toBe(2);
    expect(q.size()).toEqual({ running: 0, pending: 0 });
  });

  test('a failing job does not stop the queue', async () => {
    const q = new InProcessQueue({ concurrency: 1 });
    const results = [];
    q.add(async () => { throw new Error('boom'); }).catch(() => results.push('failed'));
    q.add(async () => results.push('ok'));
    await q.onIdle();
    expect(results).toEqual(['failed', 'ok']);
  });
});

describe('humanizeError', () => {
  test('Textract not activated → clear, non-retryable message', () => {
    const e = new Error('The AWS Access Key Id needs a subscription for the service');
    e.code = 'SubscriptionRequiredException';
    expect(humanizeError(e)).toMatchObject({ code: 'OCR_NOT_ACTIVATED', retryable: false });
  });

  test('throttling is retryable; unknown errors keep their message and retry', () => {
    expect(humanizeError({ code: 'ThrottlingException', message: 'slow down' }).retryable).toBe(true);
    expect(humanizeError(new Error('weird thing'))).toMatchObject({ code: 'PROCESSING_ERROR', message: 'weird thing', retryable: true });
  });

  test('missing file and access denied are not retried', () => {
    expect(humanizeError({ code: 'NoSuchKey', message: 'x' })).toMatchObject({ code: 'FILE_MISSING', retryable: false });
    expect(humanizeError({ code: 'AccessDenied', message: 'x' })).toMatchObject({ code: 'ACCESS_DENIED', retryable: false });
  });
});

describe('MockPartnerAdapter', () => {
  beforeAll(startDb);
  afterAll(stopDb);
  beforeEach(clearDb);

  test('looks up employees, applicants and retirees by name or ID', async () => {
    const p = getPartner();
    expect((await p.lookupPerson('1045'))[0].name).toBe('John Smith');
    expect((await p.lookupPerson('patel'))[0].employeeId).toBe('2087');
    expect((await p.lookupPerson('A-26-0402'))[0].type).toBe('applicant');
    expect((await p.lookupPerson('hughes'))[0].type).toBe('retiree');
    expect(await p.lookupPerson('')).toEqual([]);
  });

  test('a pushed document can be found by hash', async () => {
    const p = getPartner();
    expect(await p.findByHash('abc')).toBeNull();
    const { partnerDocumentId } = await p.pushDocument({ _id: '64b000000000000000000001', fileName: 'w4.pdf', sha256: 'abc' });
    expect(partnerDocumentId).toMatch(/^mock-/);
    expect(await p.findByHash('abc')).toMatchObject({ partnerDocumentId, restricted: false });
  });
});
