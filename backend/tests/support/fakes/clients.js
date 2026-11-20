// In-memory stand-ins for S3, Textract and Anthropic (replaces src/clients in tests).
const { Readable } = require('stream');

const objects = new Map();

const s3 = {
  upload: ({ Key, Body }) => ({
    promise: async () => {
      objects.set(Key, Buffer.from(Body));
      return { Key };
    },
  }),
  getObject: ({ Key }) => ({
    promise: async () => {
      if (!objects.has(Key)) {
        const e = new Error('The specified key does not exist.');
        e.code = 'NoSuchKey';
        throw e;
      }
      return { Body: objects.get(Key) };
    },
    createReadStream: () => Readable.from([objects.get(Key) || Buffer.alloc(0)]),
  }),
  deleteObject: ({ Key }) => ({
    promise: async () => {
      objects.delete(Key);
      return {};
    },
  }),
  getSignedUrl: (op, { Key }) => `https://fake-s3.local/${Key}`,
};

// Textract behaves like the dev account today: not activated.
const subscriptionError = () => {
  const e = new Error('The AWS Access Key Id needs a subscription for the service');
  e.code = 'SubscriptionRequiredException';
  return e;
};
const textract = {
  startDocumentTextDetection: (p, cb) => cb(subscriptionError()),
  startDocumentAnalysis: (p, cb) => cb(subscriptionError()),
  getDocumentTextDetection: (p, cb) => cb(subscriptionError()),
  getDocumentAnalysis: (p, cb) => cb(subscriptionError()),
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
  replies.length = 0;
}

module.exports = { s3, textract, anthropic, BUCKET: 'test-bucket', __objects: objects, __replies: replies, __reset: reset };
