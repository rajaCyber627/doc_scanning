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
const File = require('../../models/File');
const OcrPage = require('../ocr/OcrPage.model');
const { indexDocument, syncToPartner } = require('../search/indexer');
const { checkDuplicates } = require('../duplicates/service');
const { runClassification } = require('../classification/service');
const { autoSplit, isSplit } = require('../splitting/service');
const { partText } = require('../splitting/partText');

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

/** Build and store the PDF view; returns the fields to save (or undefined). */
async function renderView(ctx) {
  const f = ctx.file;
  let convertedImage = ctx.convertedImage;
  if (!convertedImage && f.ocrSourceS3Key) convertedImage = await storage.s3GetBuffer(f.ocrSourceS3Key);
  const ocrPages = await OcrPage.find({ fileId: f._id }).select('page words').sort({ page: 1 }).lean();
  const r = await buildRendition({ fileName: f.fileName, buffer: await ctx.getBuffer(), rawText: f.rawText, convertedImage, ocrPages });
  if (!r) return undefined;
  const key = `${f.s3Key}.view.pdf`;
  await storage.putStream(key, r.pdf, 'application/pdf');
  return { renditionS3Key: key, renditionMethod: r.method, ...(r.pageCount && !f.pageCount ? { pageCount: r.pageCount } : {}) };
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
      const extracted = (await partText(f)) || (await extractContent(f, await ctx.getBuffer()));
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
    name: 'separate',
    blocking: true,
    // Separator sheets (QR / printed code, optionally blank pages) → cut the file into
    // its documents automatically. The original stays, linked to its parts.
    async run(ctx) {
      const f = ctx.file;
      if (f.splitFrom || !(f.pageCount > 1)) return undefined;
      // scanned TIFFs: build the page view now (the splitter cuts its pages)
      if (!/pdf/i.test(f.mimeType || '') && !f.renditionS3Key) {
        const r = await renderView(ctx);
        if (r) await File.updateOne({ _id: f._id }, r);
        Object.assign(f, r || {});
      }
      await autoSplit(f, /pdf/i.test(f.mimeType || '') ? await ctx.getBuffer() : null);
      return undefined;
    },
  },
  {
    name: 'dedupe',
    blocking: true,
    // Same file / same content already captured (hub or partner)? → needs review.
    // A split original is represented by its parts.
    async run(ctx) {
      return isSplit(ctx.file) ? undefined : checkDuplicates(ctx.file);
    },
  },
  {
    name: 'classify',
    blocking: true,
    // AI suggestions for type / person / confidentiality / details → review queue.
    async run(ctx) {
      return isSplit(ctx.file) ? undefined : runClassification(ctx.file);
    },
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
      // parts cut from a PDF view already carry its text layer
      if (f.renditionS3Key || (f.splitFrom && f.splitFrom.hasTextLayer)) return undefined;
      return renderView(ctx);
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
