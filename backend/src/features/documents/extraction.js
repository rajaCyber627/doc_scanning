// Text extraction by file type. Returns:
//   { rawText, tablesCsv, words?, pageCount?, children?, skipped?, convertedImage?,
//     ocrSourceS3Key?, email? }
// `children` (emails, archives) are created as their own documents by the intake stage.
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const { runTextract } = require('../../providers/ocr/textract');
const { UserFacingError } = require('../../core/errors');
const { typeForName, extOf } = require('../upload/fileTypes');
const office = require('./formats/office');
const { parseEml, parseMsg } = require('./formats/email');
const { expandZip } = require('./formats/archive');
const { toJpeg } = require('./formats/images');
const { assertSafeZipDocument } = require('./formats/zipSafety');

const stripBom = (s) => s.replace(/^﻿/, '');

async function extractPdf(s3Key, buf) {
  // Try the free local text layer first; OCR only when there is little or no text
  // (i.e. a scanned / image-only PDF).
  try {
    const parsed = await pdfParse(buf);
    const text = (parsed.text || '').trim();
    const pages = parsed.numpages || 1;
    if (text.length / pages >= 100) return { rawText: text, tablesCsv: '', pageCount: pages };
  } catch (e) {
    if (/password/i.test(`${e && e.name} ${e && e.message}`))
      throw new UserFacingError('PASSWORD_PROTECTED', 'This PDF is password-protected. Remove the password and upload it again.');
    // unreadable text layer — fall through to OCR
  }
  return runTextract(s3Key);
}

async function extractImage(type, s3Key, buf, fileId) {
  if (!type.convertForOcr) return runTextract(s3Key);
  // HEIC / GIF / BMP: OCR (and browsers) need a JPEG; keep it next to the original.
  const convertedImage = await toJpeg(type.ext, buf);
  const ocrSourceS3Key = `${s3Key}.converted.jpg`;
  await storage.putStream(ocrSourceS3Key, convertedImage, 'image/jpeg');
  // Record it right away, so it is displayed and cleaned up even if OCR then fails.
  if (fileId) await File.updateOne({ _id: fileId }, { ocrSourceS3Key });
  const result = await runTextract(ocrSourceS3Key);
  return { ...result, convertedImage, ocrSourceS3Key };
}

async function extractContent({ s3Key, mimeType, fileName, buffer, fileId }) {
  const buf = buffer || (await storage.s3GetBuffer(s3Key));
  // Older documents may have been stored before every type was registered.
  const type = typeForName(fileName) || (String(mimeType).includes('pdf') ? typeForName('x.pdf') : null);
  const kind = type ? type.kind : String(mimeType || '').startsWith('text/') ? 'text' : 'image';

  switch (kind) {
    case 'pdf':
      return extractPdf(s3Key, buf);
    case 'image':
      return extractImage(type || typeForName('x.png'), s3Key, buf, fileId);
    case 'docx': {
      await assertSafeZipDocument(buf);
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { rawText: value || '', tablesCsv: '' };
    }
    case 'doc':
      return { rawText: await office.extractDoc(buf), tablesCsv: '' };
    case 'rtf':
      return { rawText: await office.extractRtf(buf), tablesCsv: '' };
    case 'odt':
      return { rawText: await office.extractOdt(buf), tablesCsv: '' };
    case 'slides': {
      const { text, pageCount } = await office.extractPptx(buf);
      return { rawText: text, tablesCsv: '', pageCount };
    }
    case 'sheet': {
      const { text, tablesCsv, pageCount } = await office.extractSheet(buf, extOf(fileName));
      return { rawText: text, tablesCsv, pageCount };
    }
    case 'email': {
      const parsed = extOf(fileName) === 'msg' ? await parseMsg(buf) : await parseEml(buf);
      return { rawText: parsed.text, tablesCsv: '', children: parsed.children, skipped: parsed.skipped, email: parsed.email };
    }
    case 'archive': {
      const parsed = await expandZip(buf);
      return { rawText: parsed.text, tablesCsv: '', children: parsed.children, skipped: parsed.skipped };
    }
    case 'text':
    default:
      return { rawText: stripBom(buf.toString('utf8')), tablesCsv: '' };
  }
}

module.exports = { extractContent };
