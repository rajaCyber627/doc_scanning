// Central configuration. Loads backend/.env once (existing environment variables
// always win, so tests and EC2 can override anything).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const env = process.env;
const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

module.exports = {
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 9000),
  mongoUri: env.MONGO_URI || 'mongodb://127.0.0.1:27017/docp',

  aws: {
    bucket: env.AWS_BUCKET_NAME,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY,
    secretAccessKey: env.AWS_ACCESS_SECRETKEY,
    textractRegion: env.TEXTRACT_REGION,
    textractAccessKeyId: env.TEXTRACT_ACCESS_KEY,
    textractSecretAccessKey: env.TEXTRACT_SECRET_ACCESS_KEY,
  },

  // All model IDs in one place (override per environment if needed).
  models: {
    main: env.CLAUDE_MODEL_MAIN || 'claude-opus-4-8',
    fast: env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001',
    // Document classification (P10): structured JSON output, low effort is enough
    classify: env.CLAUDE_MODEL_CLASSIFY || 'claude-opus-5-5',
  },

  classification: {
    // Default for the admin AI switch when it has never been set (the switch itself is
    // stored in the database and can be changed from the admin screen at any time)
    aiEnabledByDefault: env.CLASSIFICATION_AI_DEFAULT !== 'false',
    effort: env.CLASSIFICATION_EFFORT || 'low',
    maxTextChars: int(env.CLASSIFICATION_MAX_TEXT_CHARS, 30000), // text sent to the model, whole pages first
  },

  pipeline: {
    concurrency: int(env.PIPELINE_CONCURRENCY, 3),
    // Total attempts per stage (1 try + 3 retries).
    maxAttempts: int(env.PIPELINE_MAX_ATTEMPTS, 4),
    // Backoff before retry n = base * 4^(n-1) → 1s, 4s, 16s by default.
    backoffBaseMs: int(env.PIPELINE_BACKOFF_MS, 1000),
  },

  partner: {
    adapter: env.PARTNER_ADAPTER || 'mock',
  },

  text: {
    // MongoDB documents max out at 16 MB. Longer extracted text is stored in full in
    // S3 (File.textS3Key) and a capped copy is kept on the File for search / Q&A.
    maxStoredChars: int(env.TEXT_MAX_STORED_CHARS, 1000000),
  },

  formats: {
    maxChildren: int(env.FORMATS_MAX_CHILDREN, 200), // attachments / archive entries per container
    maxContainerDepth: int(env.FORMATS_MAX_CONTAINER_DEPTH, 2), // email in zip ok; deeper nesting is not expanded
    maxArchiveEntries: int(env.FORMATS_MAX_ARCHIVE_ENTRIES, 1000),
    maxArchiveBytes: int(env.FORMATS_MAX_ARCHIVE_MB, 500) * 1024 * 1024, // total uncompressed
    maxCompressionRatio: int(env.FORMATS_MAX_COMPRESSION_RATIO, 200), // zip-bomb guard (large entries only)
    maxSheetRows: int(env.FORMATS_MAX_SHEET_ROWS, 20000),
    maxRenditionPages: int(env.FORMATS_MAX_RENDITION_PAGES, 300),
    sofficePath: env.SOFFICE_PATH || '', // LibreOffice for high-fidelity Office → PDF (optional)
  },

  ocr: {
    provider: ['textract', 'fixture'].includes(env.OCR_PROVIDER) ? env.OCR_PROVIDER : 'textract',
    fixtureDir: env.OCR_FIXTURE_DIR || require('path').join(__dirname, '..', '..', 'fixtures', 'ocr'),
    forms: env.OCR_FORMS !== 'false', // read form fields + tables (AnalyzeDocument)
    // Quality flags → document goes to "needs review"
    lowConfidence: int(env.OCR_LOW_CONFIDENCE, 80), // average word confidence (%) per page
    blankPageWords: int(env.OCR_BLANK_PAGE_WORDS, 3), // fewer words than this = blank page
    handwritingRatio: Number(env.OCR_HANDWRITING_RATIO || 0.3), // share of handwritten words
    skewDegrees: Number(env.OCR_SKEW_DEGREES || 3), // tilt worth flagging / straightening
  },

  // Scanner hot folders (P13): network folders / S3 prefixes where scanners save files
  hotfolder: {
    enabled: env.HOTFOLDER_ENABLED !== 'false',
    intervalSec: int(env.HOTFOLDER_INTERVAL_SEC, 30),
    // local folders must be inside this directory (e.g. the mounted scanner share)
    root: env.HOTFOLDER_ROOT || '',
    stableSec: int(env.HOTFOLDER_STABLE_SEC, 5), // a file unchanged this long is complete
    maxFilesPerPoll: int(env.HOTFOLDER_MAX_FILES, 200),
  },

  // Email intake (P15): a shared mailbox (Microsoft Graph) or a local folder of .eml files
  emailIntake: {
    source: ['graph', 'local'].includes(env.EMAIL_INTAKE_SOURCE) ? env.EMAIL_INTAKE_SOURCE : '', // '' = off
    pollSec: int(env.EMAIL_POLL_SEC, 60),
    localDir: env.EMAIL_LOCAL_DIR || '',
    maxPerPoll: int(env.EMAIL_MAX_PER_POLL, 50),
    graph: {
      tenantId: env.GRAPH_TENANT_ID || '',
      clientId: env.GRAPH_CLIENT_ID || '',
      clientSecret: env.GRAPH_CLIENT_SECRET || '', // never logged
      mailbox: env.GRAPH_MAILBOX || '', // e.g. hr-intake@portsmouthva.gov
    },
  },

  // Shared-drive / SharePoint migration (P16)
  migration: {
    ratePerSec: Number(env.MIGRATION_RATE_PER_SEC || 5), // files per second (0 = no limit)
  },

  duplicates: {
    // Estimated text similarity (0–1) at which two documents count as the same content
    contentSimilarity: Number(env.DUPLICATE_CONTENT_SIMILARITY || 0.75),
    // …and the numbers in both (IDs, dates, amounts) must mostly agree (0–1)
    numberAgreement: Number(env.DUPLICATE_NUMBER_AGREEMENT || 0.8),
  },

  metadata: {
    // Month the City's fiscal year starts (Virginia localities: July → FY2026 = Jul 2025–Jun 2026)
    fiscalYearStartMonth: int(env.FISCAL_YEAR_START_MONTH, 7),
    // Documents go to the partner HRDMS only once their required metadata is complete
    requiredForHandoff: env.METADATA_REQUIRED_FOR_HANDOFF !== 'false',
  },

  search: {
    provider: ['mongo', 'atlas'].includes(env.SEARCH_PROVIDER) ? env.SEARCH_PROVIDER : 'mongo',
  },

  upload: {
    maxBytes: int(env.UPLOAD_MAX_MB, 100) * 1024 * 1024,
    // Files above this go to S3 as multipart (parallel parts, resumable per part).
    multipartThresholdBytes: int(env.UPLOAD_MULTIPART_MB, 10) * 1024 * 1024,
    partSizeBytes: int(env.UPLOAD_PART_MB, 8) * 1024 * 1024, // S3 minimum is 5 MB
    // 'auto' = browser tries direct-to-S3 and falls back to the server if the bucket
    // blocks the browser (CORS); 'direct' or 'proxy' force one transport.
    transport: ['auto', 'direct', 'proxy'].includes(env.UPLOAD_TRANSPORT) ? env.UPLOAD_TRANSPORT : 'auto',
    presignExpiresSec: int(env.UPLOAD_PRESIGN_SECONDS, 3600),
    sessionTtlHours: int(env.UPLOAD_SESSION_TTL_HOURS, 24),
    // The pre-P02 multipart form route (POST /api/files) stays available unless disabled.
    legacyRoute: env.UPLOAD_LEGACY_ROUTE !== 'false',
  },
};
