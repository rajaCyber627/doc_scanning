// The single list of accepted file types. The client reads it from
// GET /api/uploads/config so browser and server never disagree.
const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf, s, offset = 0) => buf.slice(offset, offset + s.length).toString('latin1') === s;

// Plain text: no NUL bytes and mostly printable characters in the sample.
function looksLikeText(buf) {
  if (!buf.length) return true;
  let printable = 0;
  for (const b of buf) {
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13 || b >= 32) printable++;
  }
  return printable / buf.length > 0.95;
}

const isPdf = (b) => ascii(b, '%PDF-') || b.slice(0, 1024).toString('latin1').includes('%PDF-');
const isPng = (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isJpeg = (b) => startsWith(b, [0xff, 0xd8, 0xff]);
const isTiff = (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]);
const isGif = (b) => ascii(b, 'GIF87a') || ascii(b, 'GIF89a');
const isBmp = (b) => ascii(b, 'BM') && b.length > 14;
const isZip = (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
// OLE compound file: legacy .doc/.xls/.msg — and also password-protected .docx/.xlsx/.pptx
const isCfb = (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const isRtf = (b) => ascii(b, '{\\rtf');
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif'];
const isHeif = (b) => ascii(b, 'ftyp', 4) && HEIF_BRANDS.includes(b.slice(8, 12).toString('latin1'));
// .eml: plain text with at least one RFC 822 header near the top
const isEml = (b) =>
  looksLikeText(b) && /^(?:[\w-]+:[^\r\n]*\r?\n)*?(?:From|To|Subject|Date|Received|Return-Path|Message-ID|MIME-Version):/im.test(b.slice(0, 4096).toString('latin1'));

const OOXML = 'application/vnd.openxmlformats-officedocument';

// kind: how the document is read. container: expands into child documents.
const TYPES = [
  { ext: 'pdf', mime: 'application/pdf', kind: 'pdf', label: 'PDF', sniff: isPdf },
  { ext: 'png', mime: 'image/png', kind: 'image', label: 'PNG image', sniff: isPng },
  { ext: 'jpg', mime: 'image/jpeg', kind: 'image', label: 'JPEG image', sniff: isJpeg },
  { ext: 'jpeg', mime: 'image/jpeg', kind: 'image', label: 'JPEG image', sniff: isJpeg },
  { ext: 'tif', mime: 'image/tiff', kind: 'image', label: 'TIFF image', sniff: isTiff },
  { ext: 'tiff', mime: 'image/tiff', kind: 'image', label: 'TIFF image', sniff: isTiff },
  { ext: 'gif', mime: 'image/gif', kind: 'image', label: 'GIF image', sniff: isGif, convertForOcr: true },
  { ext: 'bmp', mime: 'image/bmp', kind: 'image', label: 'BMP image', sniff: isBmp, convertForOcr: true },
  { ext: 'heic', mime: 'image/heic', kind: 'image', label: 'HEIC photo', sniff: isHeif, convertForOcr: true },
  { ext: 'heif', mime: 'image/heif', kind: 'image', label: 'HEIF photo', sniff: isHeif, convertForOcr: true },
  { ext: 'docx', mime: `${OOXML}.wordprocessingml.document`, kind: 'docx', label: 'Word document', sniff: isZip, ooxml: true },
  { ext: 'doc', mime: 'application/msword', kind: 'doc', label: 'Word 97-2003 document', sniff: isCfb },
  { ext: 'rtf', mime: 'application/rtf', kind: 'rtf', label: 'Rich Text document', sniff: isRtf },
  { ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', kind: 'odt', label: 'OpenDocument text', sniff: isZip },
  { ext: 'xlsx', mime: `${OOXML}.spreadsheetml.sheet`, kind: 'sheet', label: 'Excel workbook', sniff: isZip, ooxml: true },
  { ext: 'xls', mime: 'application/vnd.ms-excel', kind: 'sheet', label: 'Excel 97-2003 workbook', sniff: isCfb },
  { ext: 'pptx', mime: `${OOXML}.presentationml.presentation`, kind: 'slides', label: 'PowerPoint presentation', sniff: isZip, ooxml: true },
  { ext: 'txt', mime: 'text/plain', kind: 'text', label: 'Text', sniff: looksLikeText },
  { ext: 'md', mime: 'text/markdown', kind: 'text', label: 'Markdown', sniff: looksLikeText },
  { ext: 'csv', mime: 'text/csv', kind: 'text', label: 'CSV', sniff: looksLikeText },
  { ext: 'eml', mime: 'message/rfc822', kind: 'email', label: 'Email (.eml)', sniff: isEml, container: true },
  { ext: 'msg', mime: 'application/vnd.ms-outlook', kind: 'email', label: 'Outlook email (.msg)', sniff: isCfb, container: true },
  { ext: 'zip', mime: 'application/zip', kind: 'archive', label: 'ZIP archive', sniff: isZip, container: true },
];

const BY_EXT = new Map(TYPES.map((t) => [t.ext, t]));

// Never imported, even from inside archives or emails.
const EXECUTABLE_EXTS = new Set([
  'exe', 'dll', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'jar', 'js', 'jse', 'vbs', 'vbe',
  'wsf', 'wsh', 'ps1', 'psm1', 'sh', 'app', 'apk', 'dmg', 'iso', 'lnk', 'hta', 'reg', 'docm', 'xlsm', 'pptm',
]);

const extOf = (fileName) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
  return m ? m[1].toLowerCase() : '';
};

/** The accepted type for a file name, or null. */
const typeForName = (fileName) => BY_EXT.get(extOf(fileName)) || null;

/** Does the content match the type its extension claims? */
const contentMatches = (type, headBytes) => !!type && type.sniff(headBytes);

/** A reason the content was rejected, more specific than "doesn't match" when we can tell. */
function mismatchReason(type, headBytes, fileName) {
  if (type && type.ooxml && isCfb(headBytes))
    return `"${fileName}" is password-protected (encrypted). Remove the password in Office and upload it again.`;
  return `"${fileName}" does not contain ${type ? type.label : 'valid'} data. It may be renamed or damaged.`;
}

const isExecutableName = (fileName) => EXECUTABLE_EXTS.has(extOf(fileName));

/** Public list for the client (no functions). */
const publicTypes = () => TYPES.map(({ ext, mime, kind, label }) => ({ ext, mime, kind, label }));

module.exports = {
  TYPES,
  typeForName,
  contentMatches,
  mismatchReason,
  isExecutableName,
  publicTypes,
  extOf,
  looksLikeText,
  sniffers: { isPdf, isPng, isJpeg, isTiff, isGif, isBmp, isZip, isCfb, isRtf, isHeif, isEml },
};
