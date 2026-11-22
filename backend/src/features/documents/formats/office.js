// Text extraction for office formats: Word 97-2003 (.doc), Rich Text (.rtf),
// OpenDocument text (.odt), PowerPoint (.pptx) and spreadsheets (.xlsx / .xls).
const JSZip = require('jszip');
const WordExtractor = require('word-extractor');
const XLSX = require('xlsx');
const config = require('../../../core/config');
const { UserFacingError } = require('../../../core/errors');
const { assertSafeZipDocument } = require('./zipSafety');

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function extractDoc(buffer) {
  try {
    const doc = await new WordExtractor().extract(buffer);
    const parts = [doc.getHeaders({ includeFooters: false }), doc.getBody(), doc.getFootnotes(), doc.getEndnotes()];
    return tidy(parts.filter(Boolean).join('\n\n'));
  } catch (e) {
    if (/password|encrypt/i.test(e.message))
      throw new UserFacingError('PASSWORD_PROTECTED', 'This Word document is password-protected. Remove the password and upload it again.');
    throw new UserFacingError('DAMAGED_FILE', 'This Word 97-2003 document could not be read. Try saving it as .docx or PDF.');
  }
}

// --- RTF -------------------------------------------------------------------
// Windows-1252 characters for bytes 0x80–0x9F (\'xx escapes).
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
// Groups whose content is not document text.
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf', 'fldinst', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'filetbl',
  'revtbl', 'pgdsctbl', 'bkmkstart', 'bkmkend', 'shppict', 'nonshppict', 'blipuid', 'wgrffmtfilter', 'pnseclvl',
]);
const SYMBOLS = {
  par: '\n', line: '\n', sect: '\n\n', page: '\n\n', tab: '\t', cell: '\t', row: '\n',
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ',
};

function rtfToText(rtf) {
  let out = '';
  const stack = [];
  let skip = false;
  let ucSkip = 1;
  let i = 0;
  const n = rtf.length;
  const controlWord = /\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/y;
  while (i < n) {
    const c = rtf[i];
    if (c === '{') {
      stack.push({ skip, ucSkip });
      i++;
    } else if (c === '}') {
      const prev = stack.pop();
      if (prev) ({ skip, ucSkip } = prev);
      i++;
    } else if (c === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        if (!skip) out += next;
        i += 2;
      } else if (next === '*') {
        skip = true; // \* marks an optional destination we do not understand
        i += 2;
      } else if (next === "'") {
        const code = parseInt(rtf.substr(i + 2, 2), 16);
        if (!skip && Number.isFinite(code)) out += CP1252[code] || String.fromCharCode(code);
        i += 4;
      } else if (next === '~') {
        if (!skip) out += ' ';
        i += 2;
      } else if (next === '\n' || next === '\r') {
        if (!skip) out += '\n';
        i += 2;
      } else {
        controlWord.lastIndex = i;
        const m = controlWord.exec(rtf);
        if (!m) {
          i += 2;
          continue;
        }
        i = controlWord.lastIndex;
        const [, word, arg] = m;
        if (SKIP_DESTINATIONS.has(word)) skip = true;
        else if (skip) continue;
        else if (word === 'uc') ucSkip = Number(arg) || 1;
        else if (word === 'u') {
          let code = Number(arg);
          if (code < 0) code += 65536;
          out += String.fromCharCode(code);
          // skip the ANSI fallback characters that follow a \u escape
          for (let k = ucSkip; k > 0 && i < n; k--) {
            if (rtf[i] === '\\' && rtf[i + 1] === "'") i += 4;
            else if (rtf[i] === '{' || rtf[i] === '}' || rtf[i] === '\\') break;
            else i++;
          }
        } else if (SYMBOLS[word]) out += SYMBOLS[word];
      }
    } else {
      if (c !== '\r' && c !== '\n' && !skip) out += c;
      i++;
    }
  }
  return tidy(out);
}

async function extractRtf(buffer) {
  return rtfToText(buffer.toString('latin1'));
}

// --- ZIP-based documents ---------------------------------------------------
async function loadZip(buffer, label) {
  await assertSafeZipDocument(buffer);
  try {
    return await JSZip.loadAsync(buffer);
  } catch {
    throw new UserFacingError('DAMAGED_FILE', `This ${label} could not be opened. It may be damaged.`);
  }
}

async function extractOdt(buffer) {
  const zip = await loadZip(buffer, 'OpenDocument file');
  const xml = await zip.file('content.xml')?.async('string');
  if (!xml) throw new UserFacingError('DAMAGED_FILE', 'This OpenDocument file has no content.');
  const body = xml
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(Number(n) || 1))
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<\/table:table-cell>/g, '\t')
    .replace(/<\/table:table-row>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return tidy(decodeXml(body));
}

async function extractPptx(buffer) {
  const zip = await loadZip(buffer, 'presentation');
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, n: Number((/^ppt\/slides\/slide(\d+)\.xml$/.exec(name) || [])[1]) }))
    .filter((s) => s.n)
    .sort((a, b) => a.n - b.n);
  const parts = [];
  for (const s of slides) {
    const xml = await zip.file(s.name).async('string');
    const paras = xml
      .split(/<\/a:p>/)
      .map((p) => decodeXml((p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join('')))
      .filter((p) => p.trim());
    parts.push(`Slide ${s.n}\n${paras.join('\n')}`);
  }
  return { text: tidy(parts.join('\n\n')), pageCount: slides.length };
}

async function extractSheet(buffer, ext) {
  if (ext !== 'xls') await assertSafeZipDocument(buffer);
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, sheetRows: config.formats.maxSheetRows + 1, dense: true });
  } catch (e) {
    if (/password|encrypt/i.test(e.message))
      throw new UserFacingError('PASSWORD_PROTECTED', 'This workbook is password-protected. Remove the password and upload it again.');
    throw new UserFacingError('DAMAGED_FILE', 'This spreadsheet could not be read. It may be damaged.');
  }
  const text = [];
  const csv = [];
  wb.SheetNames.forEach((name, idx) => {
    const sheetCsv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, strip: true });
    if (!sheetCsv.trim()) return;
    text.push(`Sheet: ${name}\n${sheetCsv}`);
    csv.push(`Table ${idx + 1} (${name})\n${sheetCsv}\n`);
  });
  return { text: text.join('\n\n'), tablesCsv: csv.join('\n'), pageCount: wb.SheetNames.length };
}

module.exports = { extractDoc, extractRtf, rtfToText, extractOdt, extractPptx, extractSheet };
