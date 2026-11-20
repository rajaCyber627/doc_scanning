// The single list of accepted file types. The client reads it from
// GET /api/uploads/config so browser and server never disagree. P05 extends it.
const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const ascii = (buf, s) => buf.slice(0, s.length).toString('latin1') === s;

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
const isZip = (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);

const TYPES = [
  { ext: 'pdf', mime: 'application/pdf', kind: 'pdf', label: 'PDF', sniff: isPdf },
  { ext: 'png', mime: 'image/png', kind: 'image', label: 'PNG image', sniff: isPng },
  { ext: 'jpg', mime: 'image/jpeg', kind: 'image', label: 'JPEG image', sniff: isJpeg },
  { ext: 'jpeg', mime: 'image/jpeg', kind: 'image', label: 'JPEG image', sniff: isJpeg },
  { ext: 'tif', mime: 'image/tiff', kind: 'image', label: 'TIFF image', sniff: isTiff },
  { ext: 'tiff', mime: 'image/tiff', kind: 'image', label: 'TIFF image', sniff: isTiff },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'docx',
    label: 'Word document',
    sniff: isZip,
  },
  { ext: 'txt', mime: 'text/plain', kind: 'text', label: 'Text', sniff: looksLikeText },
  { ext: 'md', mime: 'text/markdown', kind: 'text', label: 'Markdown', sniff: looksLikeText },
  { ext: 'csv', mime: 'text/csv', kind: 'text', label: 'CSV', sniff: looksLikeText },
];

const BY_EXT = new Map(TYPES.map((t) => [t.ext, t]));

const extOf = (fileName) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
  return m ? m[1].toLowerCase() : '';
};

/** The accepted type for a file name, or null. */
const typeForName = (fileName) => BY_EXT.get(extOf(fileName)) || null;

/** Does the content match the type its extension claims? */
const contentMatches = (type, headBytes) => !!type && type.sniff(headBytes);

/** Public list for the client (no functions). */
const publicTypes = () => TYPES.map(({ ext, mime, kind, label }) => ({ ext, mime, kind, label }));

module.exports = { TYPES, typeForName, contentMatches, publicTypes, extOf, looksLikeText };
