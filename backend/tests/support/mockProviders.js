// Loaded for every test file (jest setupFilesAfterEnv): swap external services for
// in-memory fakes so tests never call AWS, Anthropic or Voyage.
jest.mock('../../src/providers/storage/client', () => {
  const f = require('./fakes/clients');
  return { s3: f.s3, BUCKET: f.BUCKET };
});
jest.mock('../../src/providers/ocr/client', () => ({ textract: require('./fakes/clients').textract }));
jest.mock('../../src/providers/llm/client', () => ({ anthropic: require('./fakes/clients').anthropic }));
jest.mock('axios', () => ({ post: jest.fn(() => Promise.reject(new Error('network disabled in tests'))) }));
