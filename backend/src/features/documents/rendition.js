// A PDF "rendition" gives every document the same kind of view. The original file is
// never changed; the rendition is a separate S3 object (File.renditionS3Key).
//   pdf, png, jpg     → none needed (browsers show them directly)
//   tiff              → one page per TIFF page
//   heic / gif / bmp  → the converted JPEG as a PDF page
//   office formats    → LibreOffice when installed, else a text PDF
//   text, csv, email  → text PDF
//   zip               → none (the archive's parts are their own documents)
const config = require('../../core/config');
const libreoffice = require('../../providers/convert/libreoffice');
const { typeForName } = require('../upload/fileTypes');
const { textToPdf, imagesToPdf } = require('./formats/pdfBuilder');
const { tiffPagesToJpeg, toJpeg } = require('./formats/images');

const OFFICE_KINDS = new Set(['docx', 'doc', 'rtf', 'odt', 'sheet', 'slides']);

/**
 * @returns {Promise<null | { pdf: Buffer, method: string, pageCount: number }>}
 */
async function buildRendition({ fileName, buffer, rawText, convertedImage }) {
  const type = typeForName(fileName);
  if (!type) return null;
  const maxPages = config.formats.maxRenditionPages;

  if (type.kind === 'pdf' || type.kind === 'archive') return null;
  if (type.kind === 'image') {
    if (type.ext === 'tif' || type.ext === 'tiff') {
      const { pages } = await tiffPagesToJpeg(buffer, maxPages);
      if (!pages.length) return null;
      return { ...(await imagesToPdf(pages)), method: 'image' };
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
