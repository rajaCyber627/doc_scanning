// OCR quality checks. Each problem becomes a review reason; any reason sends the
// document to "needs review" instead of "ready".
const config = require('../../core/config');

/** Signed angle folded to (-180, 180]. */
const fold = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Correction for a page: snap near-quarter turns, keep small skews as measured. */
function rotationOf(skew) {
  const a = fold(skew);
  for (const q of [90, -90, 180, -180]) if (Math.abs(a - q) <= 10) return { kind: 'rotated', degrees: q === -180 ? 180 : q };
  return { kind: 'skewed', degrees: a };
}

function qualityReasons(pages, { corrected = false } = {}) {
  const c = config.ocr;
  const reasons = [];
  const many = pages.length > 1;
  const label = (p) => (many ? `Page ${p.page}: ` : '');
  for (const p of pages) {
    const words = (p.words || []).length;
    if (words < c.blankPageWords) {
      reasons.push({ code: 'BLANK_PAGE', page: p.page, message: `${label(p)}no readable text — the page may be blank or too faint` });
      continue;
    }
    if (typeof p.confidence === 'number' && p.confidence < c.lowConfidence) {
      reasons.push({
        code: 'LOW_CONFIDENCE',
        page: p.page,
        message: `${label(p)}text is hard to read (${Math.round(p.confidence)}% confidence) — check it against the image`,
      });
    }
    if (p.handwritingRatio >= c.handwritingRatio) {
      reasons.push({ code: 'HANDWRITING', page: p.page, message: `${label(p)}mostly handwritten — handwriting recognition is less reliable` });
    }
    if (!corrected && Math.abs(fold(p.skewDegrees || 0)) >= c.skewDegrees) {
      const r = rotationOf(p.skewDegrees);
      reasons.push({
        code: r.kind === 'rotated' ? 'ROTATED' : 'SKEWED',
        page: p.page,
        message:
          r.kind === 'rotated'
            ? `${label(p)}scanned sideways or upside down (${Math.abs(r.degrees)}°)`
            : `${label(p)}scanned at an angle (${Math.abs(Math.round(r.degrees))}°)`,
      });
    }
  }
  return reasons;
}

module.exports = { qualityReasons, rotationOf, fold };
