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
const { createChildren } = require('../documents/children');
const { buildRendition } = require('../documents/rendition');
const OcrPage = require('../ocr/OcrPage.model');
const { indexDocument, syncToPartner } = require('../search/indexer');
const { checkDuplicates } = require('../duplicates/service');

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
    // Text / OCR extraction (per format), child documents for emails/archives, then the
    // AI overview.
    async run(ctx) {
      const f = ctx.file;
      const extracted = await extractContent(f, await ctx.getBuffer());
      const { rawText, tablesCsv } = extracted;
      ctx.convertedImage = extracted.convertedImage || null; // reused by the render stage
      let childSummary;
      if (extracted.children) {
        childSummary = await createChildren(f, extracted.children, extracted.skipped || []);
      }
      const overview = await generateOverview(rawText, tablesCsv).catch(() => ({}));
      const text = await fitText(f, rawText || '');
      return {
        ...text,
        tablesCsv: String(tablesCsv || '').slice(0, config.text.maxStoredChars),
        words: [], // word boxes now live per page in OcrPage (no size cap)
        summary: overview.summary || '',
        keyFacts: Array.isArray(overview.keyFacts) ? overview.keyFacts : [],
        suggestedQuestions: Array.isArray(overview.suggestedQuestions) ? overview.suggestedQuestions : [],
        ...(extracted.pageCount ? { pageCount: extracted.pageCount } : {}),
        ...(extracted.ocrSourceS3Key ? { ocrSourceS3Key: extracted.ocrSourceS3Key } : {}),
        ...(childSummary ? { childSummary } : {}),
        ...(extracted.email ? { 'metadata.email': extracted.email } : {}),
        ...(extracted.ocr ? { ocr: extracted.ocr } : {}),
        // OCR quality problems replace earlier OCR reasons; other stages' reasons stay
        reviewReasons: [...(f.reviewReasons || []).filter((r) => r.stage !== 'ocr'), ...(extracted.reviewReasons || [])],
      };
    },
  },
  {
    name: 'dedupe',
    blocking: true,
    // Same file / same content already captured (hub or partner)? → needs review.
    async run(ctx) {
      return checkDuplicates(ctx.file);
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
    // Full-text index record (SearchDoc), then semantic-search embeddings (best effort).
    async run(ctx) {
      await indexDocument(ctx.file._id);
      await embedFile(ctx.file);
    },
  },
  {
    name: 'render',
    blocking: false,
    // PDF view for formats browsers can't display (the original is never changed).
    async run(ctx) {
      const f = ctx.file;
      if (f.renditionS3Key) return undefined;
      let convertedImage = ctx.convertedImage;
      if (!convertedImage && f.ocrSourceS3Key) convertedImage = await storage.s3GetBuffer(f.ocrSourceS3Key);
      const ocrPages = await OcrPage.find({ fileId: f._id }).select('page words').sort({ page: 1 }).lean();
      const r = await buildRendition({ fileName: f.fileName, buffer: await ctx.getBuffer(), rawText: f.rawText, convertedImage, ocrPages });
      if (!r) return undefined;
      const key = `${f.s3Key}.view.pdf`;
      await storage.putStream(key, r.pdf, 'application/pdf');
      return { renditionS3Key: key, renditionMethod: r.method, ...(r.pageCount && !f.pageCount ? { pageCount: r.pageCount } : {}) };
    },
  },
  {
    name: 'handoff',
    blocking: false,
    // Send to the partner HRDMS (ready documents only; reviewed ones follow on review).
    async run(ctx) {
      await syncToPartner(ctx.file._id);
    },
  },
];

module.exports = { STAGES };
