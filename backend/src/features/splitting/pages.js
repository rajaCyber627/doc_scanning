// The pages of a document, as the splitter sees them.
//   page source: the PDF whose pages are cut. A PDF original is used as it is (original
//   pixels); everything else uses its PDF view (rendition), which for scans already
//   carries the OCR text layer.
//   page text:   OCR pages (P06) when the document was OCR'd, else the PDF's own text.
//   page image:  the scan image embedded in a page (JPEG), when there is one — used to
//   read QR separator sheets.
const { parsePdf } = require('../documents/formats/pdfText');
const { PDFDocument, PDFName, PDFRawStream, PDFDict } = require('pdf-lib');
const storage = require('../../providers/storage');
const OcrPage = require('../ocr/OcrPage.model');
const { UserFacingError } = require('../../core/errors');

const isPdf = (file) => /pdf/i.test(file.mimeType || '') || /\.pdf$/i.test(file.fileName || '');

/** @returns {Promise<{ buffer: Buffer, from: 'original'|'rendition', hasTextLayer: boolean }>} */
async function pageSource(file, original = null) {
  if (isPdf(file)) return { buffer: original || (await storage.s3GetBuffer(file.s3Key)), from: 'original', hasTextLayer: false };
  if (file.renditionS3Key) return { buffer: await storage.s3GetBuffer(file.renditionS3Key), from: 'rendition', hasTextLayer: true };
  // a PNG / JPEG (or converted photo) without a PDF view: wrap the image as one page
  const imageKey = file.ocrSourceS3Key || (/^image\/(png|jpeg)$/i.test(file.mimeType || '') ? file.s3Key : null);
  if (imageKey) return { buffer: await imagePdf(await storage.s3GetBuffer(imageKey)), from: 'image', hasTextLayer: false };
  throw new UserFacingError('NO_PAGES', 'The page view of this document is still being prepared. Try again in a moment.', false);
}

async function imagePdf(img) {
  const doc = await PDFDocument.create();
  const isPng = img[0] === 0x89 && img[1] === 0x50;
  const e = isPng ? await doc.embedPng(img) : await doc.embedJpg(img);
  const scale = Math.min(612 / e.width, 792 / e.height, 1);
  doc.addPage([e.width * scale, e.height * scale]).drawImage(e, { x: 0, y: 0, width: e.width * scale, height: e.height * scale });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Per-page text of a PDF (its text layer). */
async function pdfPageTexts(buffer) {
  const texts = [];
  await parsePdf(buffer, {
    pagerender: (pageData) =>
      pageData.getTextContent({ normalizeWhitespace: true }).then((tc) => {
        let last;
        let s = '';
        for (const item of tc.items) {
          s += last === undefined || last === item.transform[5] ? (s ? ' ' : '') + item.str : `\n${item.str}`;
          last = item.transform[5];
        }
        texts[pageData.pageIndex] = s;
        return s;
      }),
  });
  return Array.from(texts, (t) => t || '');
}

/** [{ page, text, wordCount }] for every page of the page source. */
async function pageTexts(file, sourceBuffer, pageCount) {
  const ocr = await OcrPage.find({ fileId: file._id }).select('page text').sort({ page: 1 }).lean();
  let texts;
  if (ocr.length) {
    texts = Array.from({ length: pageCount }, (_, i) => (ocr.find((p) => p.page === i + 1) || {}).text || '');
  } else {
    texts = await pdfPageTexts(sourceBuffer).catch(() => []);
    while (texts.length < pageCount) texts.push('');
  }
  return texts.slice(0, pageCount).map((text, i) => ({ page: i + 1, text, wordCount: (text.match(/[\p{L}\p{N}]{2,}/gu) || []).length }));
}

/**
 * The largest JPEG image drawn on each page, or null (digital pages have none).
 * Scanned PDFs and our own renditions store one JPEG per page.
 */
function pageJpegs(doc) {
  return doc.getPages().map((page) => {
    try {
      const res = page.node.Resources();
      const xo = res && res.lookup(PDFName.of('XObject'), PDFDict);
      if (!xo) return null;
      let best = null;
      for (const [, ref] of xo.entries()) {
        const obj = doc.context.lookup(ref);
        if (!(obj instanceof PDFRawStream)) continue;
        const d = obj.dict;
        if (d.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
        const filter = d.get(PDFName.of('Filter'));
        if (String(filter) !== '/DCTDecode') continue;
        if (!best || obj.contents.length > best.length) best = Buffer.from(obj.contents);
      }
      return best;
    } catch {
      return null;
    }
  });
}

async function loadPdf(buffer) {
  try {
    return await PDFDocument.load(buffer, { ignoreEncryption: false, updateMetadata: false });
  } catch (e) {
    throw new UserFacingError('DAMAGED_FILE', 'The pages of this document could not be read.', false);
  }
}

module.exports = { pageSource, pageTexts, pdfPageTexts, pageJpegs, loadPdf, isPdf };
