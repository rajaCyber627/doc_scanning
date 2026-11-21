// Text extraction by file type. Returns:
//   { rawText, tablesCsv, pageCount?, children?, skipped?, convertedImage?,
//     ocrSourceS3Key?, email?, ocr?, reviewReasons? }
// `children` (emails, archives) are created as their own documents by the intake stage.
const mammoth = require('mammoth');
const { parsePdf } = require('./formats/pdfText');
const config = require('../../core/config');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const { runOcr } = require('../ocr/service');
const { UserFacingError } = require('../../core/errors');
const { typeForName, extOf } = require('../upload/fileTypes');
const office = require('./formats/office');
const { parseEml, parseMsg } = require('./formats/email');
const { expandZip } = require('./formats/archive');
const { toJpeg, flattenPng, flattenTiff } = require('./formats/images');
const { assertSafeZipDocument } = require('./formats/zipSafety');

const stripBom = (s) => s.replace(/^﻿/, '');

async function extractPdf(file, buf) {
  // Try the free local text layer first; OCR only when there is little or no text
  // (i.e. a scanned / image-only PDF).
  try {
    const parsed = await parsePdf(buf);
    const text = (parsed.text || '').trim();
    const pages = parsed.numpages || 1;
    if (text.length / pages >= 100) return { rawText: text, tablesCsv: '', pageCount: pages };
  } catch (e) {
    if (/password/i.test(`${e && e.name} ${e && e.message}`))
      throw new UserFacingError('PASSWORD_PROTECTED', 'This PDF is password-protected. Remove the password and upload it again.');
    // unreadable text layer — fall through to OCR
  }
  return runOcr(file); // scanned / image-only PDF
}

async function extractImage(type, file, buf) {
  // Multi-page TIFFs go straight to OCR (pages are handled by the provider).
  if (type.ext === 'tif' || type.ext === 'tiff') {
    // transparent pages → a PDF copy on white is read instead (OCR would see black pages)
    const flat = await flattenTiff(buf, config.formats.maxRenditionPages);
    if (!flat) return runOcr(file);
    const key = `${file.s3Key}.converted.pdf`;
    await storage.putStream(key, flat, 'application/pdf');
    await File.updateOne({ _id: file._id }, { ocrSourceS3Key: key });
    return runOcr(file, { ocrKey: key });
  }
  if (type.ext === 'png') {
    // transparent background → flatten onto white first (OCR would see a black page)
    const flat = await flattenPng(buf);
    if (flat) {
      const key = `${file.s3Key}.converted.jpg`;
      await storage.putStream(key, flat, 'image/jpeg');
      await File.updateOne({ _id: file._id }, { ocrSourceS3Key: key });
      return runOcr(file, { ocrKey: key, image: { buffer: flat, mime: 'image/jpeg' } });
    }
  }
  if (!type.convertForOcr) return runOcr(file, { image: { buffer: buf, mime: type.mime } });
  // HEIC / GIF / BMP: OCR (and browsers) need a JPEG; keep it next to the original and
  // record it right away so it is displayed and cleaned up even if OCR then fails.
  const jpeg = await toJpeg(type.ext, buf);
  const key = `${file.s3Key}.converted.jpg`;
  await storage.putStream(key, jpeg, 'image/jpeg');
  await File.updateOne({ _id: file._id }, { ocrSourceS3Key: key });
  return runOcr(file, { ocrKey: key, image: { buffer: jpeg, mime: 'image/jpeg' } });
}

/** @param file the File document (s3Key, fileName, mimeType, _id, sha256) */
async function extractContent(file, buffer) {
  const { s3Key, mimeType, fileName } = file;
  const buf = buffer || (await storage.s3GetBuffer(s3Key));
  // Older documents may have been stored before every type was registered.
  const type = typeForName(fileName) || (String(mimeType).includes('pdf') ? typeForName('x.pdf') : null);
  const kind = type ? type.kind : String(mimeType || '').startsWith('text/') ? 'text' : 'image';

  switch (kind) {
    case 'pdf':
      return extractPdf(file, buf);
    case 'image':
      return extractImage(type || typeForName('x.png'), file, buf);
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
