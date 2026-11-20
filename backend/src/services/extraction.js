// Text extraction by file type (moved verbatim from app.js).
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { s3GetBuffer } = require('./storage');
const { runTextract } = require('./ocr');

// Pick an extractor by file type:
//   - PDF / PNG / JPG / TIFF  -> AWS Textract (text + detected tables)
//   - Word .docx              -> mammoth (raw text)
//   - .txt / .md / .csv       -> read the bytes directly
async function extractContent({ s3Key, mimeType, fileName, buffer }) {
  const name = (fileName || '').toLowerCase();
  const type = mimeType || '';
  const isDocx = name.endsWith('.docx') || type.includes('wordprocessingml');
  const isText =
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.csv') ||
    type.startsWith('text/');

  if (isDocx) {
    const buf = buffer || (await s3GetBuffer(s3Key));
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { rawText: value || '', tablesCsv: '' };
  }
  if (isText) {
    const buf = buffer || (await s3GetBuffer(s3Key));
    return { rawText: buf.toString('utf8'), tablesCsv: '' };
  }

  // PDFs: try the free local text layer first. Only fall back to Textract OCR
  // when there's little/no extractable text (i.e. a scanned/image PDF).
  const isPdf = name.endsWith('.pdf') || type.includes('pdf');
  if (isPdf) {
    try {
      const buf = buffer || (await s3GetBuffer(s3Key));
      const parsed = await pdfParse(buf);
      const text = (parsed.text || '').trim();
      const pages = parsed.numpages || 1;
      if (text.length / pages >= 100) {
        return { rawText: text, tablesCsv: '' };
      }
    } catch (e) {
      // unreadable text layer — fall through to Textract OCR
    }
  }

  return runTextract(s3Key);
}

module.exports = { extractContent };
