// Text of a split part, taken from the original at split time — never read or OCR'd
// (or charged for) a second time: OCR'd originals → the part's copied OcrPage records;
// digital originals → splitFrom.pageTexts. Merged documents (P12) → mergeOf.pageTexts.
const OcrPage = require('../ocr/OcrPage.model');
const { qualityReasons, splitQuality } = require('../ocr/quality');

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** @returns null when the part has no copied OCR pages (digital PDF → normal extraction) */
async function partText(file) {
  const origin = file.splitFrom || file.mergeOf;
  if (!origin) return null;
  // merged documents always carry every page's text (some pages may also have OCR boxes)
  if (Array.isArray(origin.pageTexts) && (file.mergeOf || !(await OcrPage.exists({ fileId: file._id })))) {
    return { rawText: origin.pageTexts.join('\n\n'), tablesCsv: '', pageCount: origin.pageTexts.length };
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
    ...splitQuality(qualityReasons(pages).map((r) => ({ ...r, stage: 'ocr' })), pages),
  };
}

module.exports = { partText };
