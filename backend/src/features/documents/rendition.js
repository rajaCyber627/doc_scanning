// A PDF "rendition" gives every document the same kind of view. The original file is
// never changed; the rendition is a separate S3 object (File.renditionS3Key).
//   OCR'd scans (pdf, png, jpg, tiff, heic…) → searchable PDF: the scan + invisible text
//   digital pdf, png/jpg without OCR → none needed (browsers show them directly)
//   tiff without OCR  → one page per TIFF page
//   heic / gif / bmp  → the converted JPEG as a PDF page
//   office formats    → LibreOffice when installed, else a text PDF
//   text, csv, email  → text PDF
//   zip               → none (the archive's parts are their own documents)
const config = require('../../core/config');
const libreoffice = require('../../providers/convert/libreoffice');
const { typeForName } = require('../upload/fileTypes');
const { textToPdf, imagesToPdf } = require('./formats/pdfBuilder');
const { tiffPagesToJpeg, toJpeg } = require('./formats/images');
const { buildSearchablePdf } = require('../ocr/searchablePdf');

const OFFICE_KINDS = new Set(['docx', 'doc', 'rtf', 'odt', 'sheet', 'slides']);

/**
 * @returns {Promise<null | { pdf: Buffer, method: string, pageCount: number }>}
 */
async function buildRendition({ fileName, buffer, rawText, convertedImage, ocrPages = [] }) {
  const type = typeForName(fileName);
  if (!type) return null;
  const maxPages = config.formats.maxRenditionPages;
  const ocr = ocrPages.length > 0;

  if (type.kind === 'archive') return null;
  if (type.kind === 'pdf') {
    // Scanned PDF: same pages, now with selectable/searchable text on top.
    return ocr ? { pdf: await buildSearchablePdf({ pdf: buffer, pages: ocrPages }), method: 'ocr', pageCount: null } : null;
  }
  if (type.kind === 'image') {
    if (type.ext === 'tif' || type.ext === 'tiff') {
      const { pages } = await tiffPagesToJpeg(buffer, maxPages);
      if (!pages.length) return null;
      if (ocr) return { pdf: await buildSearchablePdf({ images: pages, pages: ocrPages }), method: 'ocr', pageCount: pages.length };
      return { ...(await imagesToPdf(pages)), method: 'image' };
    }
    if (ocr) {
      const img = convertedImage || (type.convertForOcr ? await toJpeg(type.ext, buffer) : buffer);
      return { pdf: await buildSearchablePdf({ images: [img], pages: ocrPages }), method: 'ocr', pageCount: 1 };
    }
    if (type.convertForOcr) {
      const jpg = convertedImage || (await toJpeg(type.ext, buffer));
      return { ...(await imagesToPdf([jpg])), method: 'image' };
    }
    return null; // png / jpg display natively
  }
  if (OFFICE_KINDS.has(type.kind) && libreoffice.isAvailable()) {
    try {
      const pdf = await libreoffice.convertToPdf(buffer, type.ext);
      return { pdf, method: 'libreoffice', pageCount: null };
    } catch (e) {
      console.error('LibreOffice conversion failed, using text view:', e && e.message);
    }
  }
  const { pdf, pageCount } = await textToPdf(rawText, { title: fileName, maxPages });
  return { pdf, method: 'text', pageCount };
}

module.exports = { buildRendition };
