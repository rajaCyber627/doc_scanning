// Content fingerprints for duplicate detection.
//  contentHash — SHA-256 of the normalized text: identical wording, any file format
//  minhash     — 64-value MinHash of 5-word shingles: estimates text similarity, so a
//                .docx and its PDF export (or the same paper scanned twice) match even
//                when headers, line breaks or a few OCR errors differ
//  lshBands    — 16 bands × 4 values of the MinHash, indexed: candidate lookup without
//                comparing against every document
//  numbers     — the distinct numbers in the text (IDs, dates, amounts). HR forms are
//                templates: two W-4s for different employees share most wording but not
//                their numbers, so similar text only counts when the numbers agree too.
const crypto = require('crypto');

const NUM_HASHES = 64;
const BANDS = 16;
const ROWS = NUM_HASHES / BANDS;
const SHINGLE = 5;

// Deterministic per-hash seeds (xorshift32).
const SEEDS = (() => {
  let x = 0x9e3779b9;
  return Array.from({ length: NUM_HASHES }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  });
})();

function normalizeForMatch(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mix(h, seed) {
  let x = (h ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Fingerprint of a document's text; null when there is too little text to judge. */
function fingerprint(text, { minWords = 30 } = {}) {
  const norm = normalizeForMatch(text);
  const words = norm ? norm.split(' ') : [];
  if (words.length < minWords) return null;
  const shingles = new Set();
  for (let i = 0; i + SHINGLE <= words.length; i++) shingles.add(words.slice(i, i + SHINGLE).join(' '));
  const sig = new Array(NUM_HASHES).fill(0xffffffff);
  for (const s of shingles) {
    const h = fnv1a(s);
    for (let i = 0; i < NUM_HASHES; i++) {
      const v = mix(h, SEEDS[i]);
      if (v < sig[i]) sig[i] = v;
    }
  }
  const lshBands = Array.from({ length: BANDS }, (_, b) => `${b}:${sig.slice(b * ROWS, b * ROWS + ROWS).join('.')}`);
  return {
    contentHash: crypto.createHash('sha256').update(norm).digest('hex'),
    minhash: sig,
    lshBands,
    numbers: numbersIn(text),
    words: words.length,
  };
}

/** Distinct numbers (2+ digits, punctuation removed): IDs, dates, amounts. */
function numbersIn(text) {
  const found = String(text || '').match(/\d[\d.,/:-]*\d/g) || [];
  return [...new Set(found.map((n) => n.replace(/[^\d]/g, '')).filter((n) => n.length >= 2))].sort().slice(0, 300);
}

/** Jaccard similarity of two sets (1 when both are empty). */
function setSimilarity(a = [], b = []) {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  let inter = 0;
  for (const x of new Set(b)) if (A.has(x)) inter++;
  return inter / (A.size + new Set(b).size - inter);
}

/** Estimated Jaccard similarity of two MinHash signatures (0–1). */
function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

module.exports = { fingerprint, similarity, setSimilarity, numbersIn, normalizeForMatch, NUM_HASHES, BANDS };
