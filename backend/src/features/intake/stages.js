// The intake pipeline, in order. Each stage returns the fields to save on the
// document (or nothing). "blocking" stages must succeed before the document is
// "ready"; non-blocking stages run after it is ready and their failures are
// logged without failing the document.
const crypto = require('crypto');
const { extractContent } = require('../documents/extraction');
const { generateOverview } = require('../documents/overview');
const { embedFile } = require('../query/semanticIndex');
const config = require('../../core/config');
const storage = require('../../providers/storage');

/**
 * Keep the stored text under MongoDB's 16 MB document limit: very long text is saved
 * in full to S3 next to the original, and a capped copy stays on the document.
 */
async function fitText(file, rawText) {
  const max = config.text.maxStoredChars;
  if (rawText.length <= max) {
    return { rawText, textLength: rawText.length, textTruncated: false, textS3Key: null };
  }
  const textS3Key = `${file.s3Key}.extracted.txt`;
  await storage.putStream(textS3Key, Buffer.from(rawText, 'utf8'), 'text/plain; charset=utf-8');
  return { rawText: rawText.slice(0, max), textLength: rawText.length, textTruncated: true, textS3Key };
}

const STAGES = [
  {
    name: 'store',
    blocking: true,
    // The file is already in S3 (uploaded before the pipeline starts); record its size.
    async run(ctx) {
      const buf = await ctx.getBuffer();
      return { sizeBytes: buf.length };
    },
  },
  {
    name: 'hash',
    blocking: true,
    // SHA-256 fingerprint of the original file (used by duplicate detection, P08).
    async run(ctx) {
      const buf = await ctx.getBuffer();
      return { sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    },
  },
  {
    name: 'extract',
    blocking: true,
    // Text / OCR extraction, then the AI overview (unchanged behaviour from before P01).
    async run(ctx) {
      const f = ctx.file;
      const { rawText, tablesCsv, words } = await extractContent({
        s3Key: f.s3Key,
        mimeType: f.mimeType,
        fileName: f.fileName,
        buffer: await ctx.getBuffer(),
      });
      const overview = await generateOverview(rawText, tablesCsv).catch(() => ({}));
      const text = await fitText(f, rawText || '');
      return {
        ...text,
        tablesCsv: String(tablesCsv || '').slice(0, config.text.maxStoredChars),
        words: Array.isArray(words) ? words : [],
        summary: overview.summary || '',
        keyFacts: Array.isArray(overview.keyFacts) ? overview.keyFacts : [],
        suggestedQuestions: Array.isArray(overview.suggestedQuestions) ? overview.suggestedQuestions : [],
      };
    },
  },
  {
    name: 'classify',
    blocking: true,
    // Document type / person / metadata suggestions — implemented in P10.
    async run() {},
  },
  {
    name: 'index',
    blocking: false,
    // Semantic-search embeddings (best effort, as before). Full-text indexing: P07.
    async run(ctx) {
      await embedFile(ctx.file);
    },
  },
  {
    name: 'handoff',
    blocking: false,
    // Push to the partner HRDMS via PartnerAdapter — implemented in P07.
    async run() {},
  },
];

module.exports = { STAGES };
