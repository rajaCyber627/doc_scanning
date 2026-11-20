// In-memory stand-ins for S3, Textract and Anthropic (replaces src/clients in tests).
const { Readable } = require('stream');

const objects = new Map();
const multiparts = new Map(); // uploadId → { Key, parts: Map(partNumber → Buffer) }

const noSuchKey = () => {
  const e = new Error('The specified key does not exist.');
  e.code = 'NoSuchKey';
  e.statusCode = 404;
  return e;
};

async function toBuffer(body) {
  if (Buffer.isBuffer(body) || typeof body === 'string') return Buffer.from(body);
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const s3 = {
  upload: ({ Key, Body }) => ({
    promise: async () => {
      objects.set(Key, await toBuffer(Body));
      return { Key };
    },
  }),
  getObject: ({ Key, Range }) => ({
    promise: async () => {
      if (!objects.has(Key)) throw noSuchKey();
      const buf = objects.get(Key);
      if (Range) {
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(Range);
        return { Body: buf.subarray(Number(a), Number(b) + 1) };
      }
      return { Body: buf };
    },
    createReadStream: () => Readable.from([objects.get(Key) || Buffer.alloc(0)]),
  }),
  headObject: ({ Key }) => ({
    promise: async () => {
      if (!objects.has(Key)) {
        const e = new Error('Not Found');
        e.code = 'NotFound';
        e.statusCode = 404;
        throw e;
      }
      return { ContentLength: objects.get(Key).length, ContentType: 'application/octet-stream' };
    },
  }),
  deleteObject: ({ Key }) => ({
    promise: async () => {
      objects.delete(Key);
      return {};
    },
  }),
  createMultipartUpload: ({ Key }) => ({
    promise: async () => {
      const UploadId = `mp-${multiparts.size + 1}-${Date.now()}`;
      multiparts.set(UploadId, { Key, parts: new Map() });
      return { UploadId };
    },
  }),
  completeMultipartUpload: ({ Key, UploadId, MultipartUpload }) => ({
    promise: async () => {
      const mp = multiparts.get(UploadId);
      if (!mp || mp.Key !== Key) throw noSuchKey();
      const bufs = MultipartUpload.Parts.map((p) => {
        const b = mp.parts.get(p.PartNumber);
        if (!b || p.ETag !== `"etag-${p.PartNumber}"`) {
          const e = new Error('One or more of the specified parts could not be found.');
          e.code = 'InvalidPart';
          throw e;
        }
        return b;
      });
      objects.set(Key, Buffer.concat(bufs));
      multiparts.delete(UploadId);
      return {};
    },
  }),
  abortMultipartUpload: ({ UploadId }) => ({
    promise: async () => {
      multiparts.delete(UploadId);
      return {};
    },
  }),
  getSignedUrl: (op, p) =>
    op === 'uploadPart'
      ? `https://fake-s3.local/${p.Key}?uploadId=${p.UploadId}&partNumber=${p.PartNumber}`
      : `https://fake-s3.local/${p.Key}?op=${op}`,
};

/** Simulate the browser PUTting one part to its presigned URL; returns its ETag. */
function putPart(uploadId, partNumber, buf) {
  multiparts.get(uploadId).parts.set(partNumber, Buffer.from(buf));
  return `"etag-${partNumber}"`;
}

// Textract behaves like the dev account today: not activated.
const subscriptionError = () => {
  const e = new Error('The AWS Access Key Id needs a subscription for the service');
  e.code = 'SubscriptionRequiredException';
  return e;
};
// Set textractState.mode = 'ok' in a test to simulate an activated account; every
// object OCR'd is recorded in textractState.calls.
// textractState.results: Map(s3 key | 'default' → Textract blocks) to script results;
// textractState.byCall: array of blocks returned in order (for re-OCR after straightening).
const { buildBlocks } = require('../../../src/providers/ocr/buildBlocks');
const textractState = { mode: 'subscription', calls: [], results: new Map(), byCall: [], features: [] };
const defaultBlocks = (key) =>
  buildBlocks([{ lines: [{ text: `OCR text of ${key.split('/').pop()}` }, { text: 'Employee: John Smith' }, { text: 'Employee ID: 1045' }] }]);
const okResult = (key) => ({
  JobStatus: 'SUCCEEDED',
  Blocks: textractState.byCall.length ? textractState.byCall.shift() : textractState.results.get(key) || textractState.results.get('default') || defaultBlocks(key),
});
const jobs = new Map();
const start = (p, cb) => {
  if (textractState.mode !== 'ok') return cb(subscriptionError());
  if (textractState.denyAnalysis && p.FeatureTypes) {
    const e = new Error('User is not authorized to perform: textract:StartDocumentAnalysis');
    e.code = 'AccessDeniedException';
    return cb(e);
  }
  const key = p.DocumentLocation.S3Object.Name;
  if (!objects.has(key)) return cb(noSuchKey());
  textractState.calls.push(key);
  textractState.features.push(p.FeatureTypes || null);
  const JobId = `job-${jobs.size + 1}`;
  jobs.set(JobId, key);
  return cb(null, { JobId });
};
const get = (p, cb) => (textractState.mode !== 'ok' ? cb(subscriptionError()) : cb(null, okResult(jobs.get(p.JobId) || '')));
const textract = {
  startDocumentTextDetection: start,
  startDocumentAnalysis: start,
  getDocumentTextDetection: get,
  getDocumentAnalysis: get,
};

// Anthropic: returns a fixed overview; tests can queue other replies.
const replies = [];
const anthropic = {
  messages: {
    create: async () => {
      const text =
        replies.length > 0
          ? replies.shift()
          : JSON.stringify({
              summary: 'Test summary',
              keyFacts: [{ label: 'Employee', value: 'John Smith' }],
              suggestedQuestions: ['What is the rating?'],
            });
      return { content: [{ type: 'text', text }] };
    },
  },
};

function reset() {
  objects.clear();
  multiparts.clear();
  replies.length = 0;
  jobs.clear();
  textractState.mode = 'subscription';
  textractState.calls.length = 0;
  textractState.results.clear();
  textractState.byCall.length = 0;
  textractState.features.length = 0;
  textractState.denyAnalysis = false;
}

module.exports = {
  s3,
  textract,
  anthropic,
  BUCKET: 'test-bucket',
  __objects: objects,
  __multiparts: multiparts,
  __putPart: putPart,
  __replies: replies,
  __textract: textractState,
  __reset: reset,
};
