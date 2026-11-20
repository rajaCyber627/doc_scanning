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
};
