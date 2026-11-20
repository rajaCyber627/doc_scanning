// Build simple PDFs with pdf-lib: a paginated text PDF (fallback view for office,
// text and email documents; selectable text keeps "find in document" working) and
// an images-to-PDF (one page per image).
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE = { w: 612, h: 792, margin: 54 };

// Standard PDF fonts only cover Windows-1252; map common Unicode punctuation and
// replace anything else so building never fails on unusual characters.
const REPLACE = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '*', ' ': ' ', '\t': '    ' };
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
function sanitize(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const r = REPLACE[ch];
    if (r !== undefined) out += r;
    else {
      const code = ch.codePointAt(0);
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch) || ch === '\n') out += ch;
      else if (code < 0x20) out += ' ';
      else out += '?';
    }
  }
  return out;
}

function wrap(line, font, size, maxWidth) {
  const words = line.split(/(\s+)/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur + w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) cur = next;
    else if (!cur.trim()) {
      // a single very long word: hard-break it
      let chunk = '';
      for (const ch of w) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += ch;
      }
      cur = chunk;
    } else {
      lines.push(cur.trimEnd());
      cur = w.trimStart();
    }
  }
  lines.push(cur.trimEnd());
  return lines;
}

/** Paginated text PDF. Returns { pdf: Buffer, pageCount, truncated }. */
async function textToPdf(text, { title = '', maxPages = 300 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 10.5;
  const lineH = 14;
  const maxW = PAGE.w - PAGE.margin * 2;
  let page = null;
  let y = 0;
  let truncated = false;
  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.margin;
  };
  newPage();
  if (title) {
    for (const l of wrap(sanitize(title), bold, 13, maxW)) {
      page.drawText(l, { x: PAGE.margin, y, size: 13, font: bold, color: rgb(0.1, 0.1, 0.1) });
      y -= 18;
    }
    y -= 6;
  }
  const body = sanitize(text || '(no text)').split('\n');
  outer: for (const raw of body) {
    for (const l of wrap(raw, font, size, maxW)) {
      if (y < PAGE.margin) {
        if (doc.getPageCount() >= maxPages) {
          truncated = true;
          break outer;
        }
        newPage();
      }
      if (l) page.drawText(l, { x: PAGE.margin, y, size, font, color: rgb(0.12, 0.12, 0.12) });
      y -= lineH;
    }
  }
  if (truncated) {
    page.drawText(`… preview truncated after ${maxPages} pages`, { x: PAGE.margin, y: PAGE.margin / 2, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
  }
  return { pdf: Buffer.from(await doc.save()), pageCount: doc.getPageCount(), truncated };
}

/** One page per JPEG image, page sized to the image's aspect ratio. */
async function imagesToPdf(jpegs) {
  const doc = await PDFDocument.create();
  for (const jpg of jpegs) {
    const img = await doc.embedJpg(jpg);
    const scale = Math.min(PAGE.w / img.width, PAGE.h / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return { pdf: Buffer.from(await doc.save()), pageCount: doc.getPageCount() };
}

module.exports = { textToPdf, imagesToPdf, sanitize };
