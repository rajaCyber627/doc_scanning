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
  UPLOAD_MULTIPART_MB: '1', // small so multipart can be tested with small buffers
  UPLOAD_PART_MB: '1',
  UPLOAD_MAX_MB: '100',
  UPLOAD_TRANSPORT: 'auto',
  CLASSIFICATION_AI_DEFAULT: 'false', // AI suggestions off unless a test turns them on
  TEXT_MAX_STORED_CHARS: '50000', // small so the "very long text" path is testable
  FORMATS_MAX_ARCHIVE_ENTRIES: '50', // small so the zip limits are testable
  SOFFICE_PATH: '/nonexistent/soffice', // tests always use the built-in text PDF view
  AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE: '1',
});
