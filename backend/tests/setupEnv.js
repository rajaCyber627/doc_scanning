// Runs before any test module loads. Setting every secret/endpoint here means the
// real backend/.env values are never used in tests (dotenv does not override).
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://invalid-host-tests-use-memory-server:1/none',
  ANTHROPIC_API_KEY: 'test-key',
  VOYAGE_API_KEY: 'test-key',
  AWS_BUCKET_NAME: 'test-bucket',
  AWS_REGION: 'us-east-1',
  TEXTRACT_REGION: 'us-east-1',
  AWS_ACCESS_KEY: 'test',
  AWS_ACCESS_SECRETKEY: 'test',
  TEXTRACT_ACCESS_KEY: 'test',
  TEXTRACT_SECRET_ACCESS_KEY: 'test',
  SMTP_USER: '',
  SMTP_PASS: '',
  PIPELINE_BACKOFF_MS: '0',
  PIPELINE_MAX_ATTEMPTS: '4',
  PARTNER_ADAPTER: 'mock',
  AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE: '1',
});
