// AWS Textract (async API: works for images, PDFs and multi-page TIFFs in S3).
// analyze() prefers AnalyzeDocument with FORMS + TABLES (form fields and tables) and
// falls back to DetectDocumentText (text only) if the account may not use analysis.
const { textract } = require('./client');
const { BUCKET } = require('../storage/client');
const { normalizeBlocks } = require('./normalize');

const call = (fn, params) =>
  new Promise((resolve, reject) => textract[fn](params, (err, data) => (err ? reject(err) : resolve(data))));

const POLL_MS = 1500;
const MAX_WAIT_MS = 15 * 60 * 1000;

async function runJob(mode, key) {
  const loc = { DocumentLocation: { S3Object: { Bucket: BUCKET, Name: key } } };
  const startFn = mode === 'analysis' ? 'startDocumentAnalysis' : 'startDocumentTextDetection';
  const getFn = mode === 'analysis' ? 'getDocumentAnalysis' : 'getDocumentTextDetection';
  const { JobId } = await call(startFn, mode === 'analysis' ? { ...loc, FeatureTypes: ['TABLES', 'FORMS'] } : loc);

  const started = Date.now();
  let first;
  for (;;) {
    first = await call(getFn, { JobId });
    if (first.JobStatus === 'SUCCEEDED' || first.JobStatus === 'PARTIAL_SUCCESS') break;
    if (first.JobStatus !== 'IN_PROGRESS') {
      throw new Error(`Textract job ${first.JobStatus}${first.StatusMessage ? `: ${first.StatusMessage}` : ''}`);
    }
    if (Date.now() - started > MAX_WAIT_MS) throw new Error('Textract job timed out');
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const blocks = [...(first.Blocks || [])];
  let token = first.NextToken;
  while (token) {
    const page = await call(getFn, { JobId, NextToken: token });
    blocks.push(...(page.Blocks || []));
    token = page.NextToken;
  }
  return blocks;
}

const isAccessDenied = (e) =>
  !!e && (e.code === 'AccessDeniedException' || /not authorized|accessdenied/i.test(e.message || ''));

/** OCR an S3 object → normalized pages (see normalize.js). */
async function analyze(key, { forms = true } = {}) {
  let blocks;
  let mode = forms ? 'analysis' : 'text';
  try {
    blocks = await runJob(mode, key);
  } catch (e) {
    if (!(isAccessDenied(e) && mode === 'analysis')) throw e;
    console.warn('Textract analysis not permitted; using text detection');
    mode = 'text';
    blocks = await runJob(mode, key);
  }
  return { ...normalizeBlocks(blocks), provider: 'textract', mode };
}

module.exports = { analyze };
