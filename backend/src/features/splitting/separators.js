// Separator sheets: a printed page placed between documents before scanning. Each
// sheet carries the same code twice — as a QR code and as a printed text line — so it
// is found either from the scan image (QR) or from the OCR / text layer:
//     DOCP-SEP:v1;type=<document type key>;emp=<employee ID>
// type and emp are optional and pre-fill the details of the document that follows.
// Optional "blank page = separator" mode treats empty pages as cuts too.
const Jimp = require('jimp');
const jsQR = require('jsqr');
const QRCode = require('qrcode');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PREFIX = 'DOCP-SEP:v1';
// OCR may read ';' as ':' or ','; values never contain spaces
const CODE_RE = /DOCP[-\s]?SEP\s*:\s*v1((?:\s*[;:,]\s*[a-z]+\s*=\s*[\w.-]+)*)/i;

function encode({ documentType, employeeId } = {}) {
  const parts = [PREFIX];
  if (documentType) parts.push(`type=${String(documentType).trim()}`);
  if (employeeId) parts.push(`emp=${String(employeeId).trim()}`);
  return parts.join(';');
}

/** Parse a separator code out of any text. Returns null or { documentType?, employeeId? }. */
function parse(text) {
  const m = CODE_RE.exec(String(text || ''));
  if (!m) return null;
  const out = {};
  for (const kv of m[1].split(/[;:,]/)) {
    const [k, v] = kv.split('=').map((s) => (s || '').replace(/\s+/g, ''));
    if (!v) continue;
    if (/^type$/i.test(k) && /^[\w.-]{2,120}$/.test(v)) out.documentType = v.toLowerCase();
    if (/^emp$/i.test(k) && /^[\w-]{1,40}$/.test(v)) out.employeeId = v;
  }
  return out;
}

/** Decode a QR code from a page image; tries the full page, then a downscaled copy. */
async function readQr(jpeg) {
  let img;
  try {
    img = await Jimp.read(jpeg);
  } catch {
    return null;
  }
  for (const width of [img.bitmap.width, 1000, 600]) {
    if (width > img.bitmap.width) continue;
    const im = width === img.bitmap.width ? img : img.clone().resize(width, Jimp.AUTO);
    const { data, width: w, height: h } = im.bitmap;
    const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w, h, { inversionAttempts: 'dontInvert' });
    if (code && code.data) return code.data;
  }
  return null;
}

/**
 * @param pages  [{ page, text, wordCount }]
 * @param images [Buffer|null] page JPEGs (same order)
 * @param opts.blankIsSeparator treat blank pages as separators
 * @param opts.blankWords       fewer words than this = blank
 * @returns [{ page, via: 'qr'|'text'|'blank', prefill }]
 */
async function detect(pages, images = [], { blankIsSeparator = false, blankWords = 3 } = {}) {
  const found = [];
  for (const p of pages) {
    const fromText = parse(p.text);
    if (fromText) {
      found.push({ page: p.page, via: 'text', prefill: fromText });
      continue;
    }
    const jpeg = images[p.page - 1];
    // a separator sheet has almost no other text; skip QR decoding on busy pages
    if (jpeg && p.wordCount < 40) {
      const data = await readQr(jpeg);
      const fromQr = data && parse(data);
      if (fromQr) {
        found.push({ page: p.page, via: 'qr', prefill: fromQr });
        continue;
      }
    }
    if (blankIsSeparator && p.wordCount < blankWords) found.push({ page: p.page, via: 'blank', prefill: {} });
  }
  return found;
}

/**
 * Parts between separators. Separator pages are dropped.
 * @returns [{ from, to, prefill }]
 */
function partsFromSeparators(pageCount, separators) {
  const sepPages = new Map(separators.map((s) => [s.page, s]));
  const parts = [];
  let cur = null;
  let pending = {};
  for (let p = 1; p <= pageCount; p++) {
    const sep = sepPages.get(p);
    if (sep) {
      if (cur) parts.push(cur);
      cur = null;
      pending = sep.prefill || {};
      continue;
    }
    if (!cur) {
      cur = { from: p, to: p, prefill: pending };
      pending = {};
    } else cur.to = p;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Printable separator sheet (US Letter). One sheet per call; print as many as needed. */
async function sheetPdf({ documentType = '', documentTypeName = '', employeeId = '', copies = 1 } = {}) {
  const code = encode({ documentType, employeeId });
  const qr = QRCode.create(code, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const doc = await PDFDocument.create();
  doc.setTitle('Document separator sheet');
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  for (let c = 0; c < Math.min(Math.max(1, copies), 100); c++) {
    const page = doc.addPage([612, 792]);
    page.drawText('SEPARATOR SHEET', { x: 160, y: 700, size: 34, font });
    page.drawText('Place this page in front of the next document before scanning.', { x: 120, y: 670, size: 12, font: regular });
    page.drawText('It is removed automatically and never filed.', { x: 180, y: 652, size: 12, font: regular });
    // QR: 4-module quiet zone, 6 pt per module minimum
    const mod = Math.max(6, Math.floor(300 / (n + 8)));
    const size = mod * n;
    const x0 = (612 - size) / 2;
    const y0 = 300;
    for (let r = 0; r < n; r++)
      for (let col = 0; col < n; col++)
        if (qr.modules.get(r, col)) page.drawRectangle({ x: x0 + col * mod, y: y0 + (n - 1 - r) * mod, width: mod, height: mod, color: rgb(0, 0, 0) });
    let y = 250;
    if (documentTypeName || documentType) {
      page.drawText(`Document type: ${documentTypeName || documentType}`, { x: 72, y, size: 14, font: regular });
      y -= 22;
    }
    if (employeeId) {
      page.drawText(`Employee ID: ${employeeId}`, { x: 72, y, size: 14, font: regular });
      y -= 22;
    }
    // the same code as plain text, so OCR finds it even if the QR is damaged
    page.drawText(code, { x: 72, y: 90, size: 13, font: mono });
  }
  return Buffer.from(await doc.save());
}

module.exports = { encode, parse, detect, partsFromSeparators, sheetPdf, readQr, PREFIX };
