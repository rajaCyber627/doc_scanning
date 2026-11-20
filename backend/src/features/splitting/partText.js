// Text of a split part, taken from the original at split time — never read or OCR'd
// (or charged for) a second time: OCR'd originals → the part's copied OcrPage records;
// digital originals → splitFrom.pageTexts.
const OcrPage = require('../ocr/OcrPage.model');
const { qualityReasons } = require('../ocr/quality');

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @returns null when the part has no copied OCR pages (digital PDF → normal extraction) */
async function partText(file) {
  if (!file.splitFrom) return null;
  if (Array.isArray(file.splitFrom.pageTexts)) {
    return { rawText: file.splitFrom.pageTexts.join('\n\n'), tablesCsv: '', pageCount: file.splitFrom.pageTexts.length };
  }
  const pages = await OcrPage.find({ fileId: file._id }).sort({ page: 1 }).lean();
  if (!pages.length) return null;
  let n = 0;
  const tablesCsv = pages
    .flatMap((pg) => (pg.tables || []).map((t) => `Table ${++n} (page ${pg.page})\n${(t.rows || []).map((r) => r.map(csvCell).join(',')).join('\n')}\n`))
    .join('\n');
  const confs = pages.map((p) => p.confidence).filter((c) => typeof c === 'number');
  return {
    rawText: pages.map((p) => p.text).join('\n\n'),
    tablesCsv,
    pageCount: pages.length,
    ocr: {
      provider: 'split',
      mode: 'reused',
      pages: pages.length,
      avgConfidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10 : null,
      corrected: false,
      keyValues: pages.flatMap((p) => (p.keyValues || []).map((kv) => ({ ...kv, page: p.page }))).slice(0, 200),
    },
    reviewReasons: qualityReasons(pages).map((r) => ({ ...r, stage: 'ocr' })),
  };
}

module.exports = { partText };
