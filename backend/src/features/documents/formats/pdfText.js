// pdf-parse with a fallback: its default pdf.js (1.10) rejects some valid PDFs (e.g.
// "bad XRef entry" on pages copied by pdf-lib); the newer bundled pdf.js reads them.
const pdfParse = require('pdf-parse');

const FALLBACK = 'v2.0.550';

async function parsePdf(buffer, opts = {}) {
  try {
    return await pdfParse(buffer, opts);
  } catch (e) {
    if (/password/i.test(`${e && e.name} ${e && e.message}`)) throw e;
    return pdfParse(buffer, { ...opts, version: FALLBACK });
  }
}

module.exports = { parsePdf, FALLBACK };
