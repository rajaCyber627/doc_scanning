// Searchable PDF: the scan stays exactly as it looks, with the OCR'd words laid over it
// as invisible text in the right places — so text can be selected, copied and found.
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { sanitize } = require('../documents/formats/pdfBuilder');

function overlayWords(page, words, font) {
  const { width: W, height: H } = page.getSize();
  for (const w of words || []) {
    const text = sanitize(w.t).replace(/\n/g, ' ').trim();
    if (!text) continue;
    const size = Math.max(1, Math.min(72, w.h * H * 0.85));
    const natural = font.widthOfTextAtSize(text, size);
    // shrink the font if the word would run past its box
    const fit = natural > 0 && w.w > 0 ? Math.min(1, (w.w * W) / natural) : 1;
    page.drawText(text, {
      x: w.x * W,
      y: H - (w.y + w.h) * H + w.h * H * 0.15,
      size: size * fit,
      font,
      opacity: 0,
    });
  }
}

/**
 * @param {{ pdf?: Buffer, images?: Buffer[], pages: Array<{ page, words }> }} input
 *   pdf    — original scanned PDF (text is added on top of its pages), or
 *   images — one JPEG/PNG per page
 */
async function buildSearchablePdf({ pdf, images, pages }) {
  const byPage = new Map(pages.map((p) => [p.page, p.words]));
  let doc;
  if (pdf) {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  } else {
    doc = await PDFDocument.create();
    for (const img of images) {
      const isPng = img[0] === 0x89 && img[1] === 0x50;
      const embedded = isPng ? await doc.embedPng(img) : await doc.embedJpg(img);
      const scale = Math.min(612 / embedded.width, 792 / embedded.height, 1);
      const pg = doc.addPage([embedded.width * scale, embedded.height * scale]);
      pg.drawImage(embedded, { x: 0, y: 0, width: embedded.width * scale, height: embedded.height * scale });
    }
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPages().forEach((pg, i) => overlayWords(pg, byPage.get(i + 1), font));
  return Buffer.from(await doc.save());
}

module.exports = { buildSearchablePdf };
