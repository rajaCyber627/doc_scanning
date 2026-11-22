// Search over SearchDoc with a MongoDB text index: words are stemmed ("promotions"
// finds "promotion"), "quoted phrases" and -exclusions work, results are ranked.
// If nothing matches a single short term, a substring match is tried so partial words
// ("Smi") still find documents, like the old search did.
const SearchDoc = require('../../models/SearchDoc');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Phrases and terms to highlight (exclusions skipped). */
function highlightTerms(q) {
  const phrases = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  const rest = q.replace(/"[^"]*"/g, ' ');
  const terms = rest
    .split(/\s+/)
    .filter((t) => t && !t.startsWith('-'))
    .map((t) => t.replace(/[^\p{L}\p{N}@._-]/gu, ''))
    .filter((t) => t.length > 1);
  return [...phrases, ...terms];
}

/** A short excerpt around the first match + highlight ranges inside it (no HTML). */
function snippetFor(text, terms, maxLen = 240) {
  if (!text || !terms.length) return { snippet: (text || '').slice(0, maxLen), highlights: [], count: 0, firstIndex: -1 };
  // terms match at word starts (stemmed variants like "promotions" for "promotion")
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${terms.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})`, 'giu');
  const matches = [...text.matchAll(re)].slice(0, 1000);
  if (!matches.length) return { snippet: text.slice(0, maxLen).replace(/\s+/g, ' '), highlights: [], count: 0, firstIndex: -1 };
  const first = matches[0].index;
  const start = Math.max(0, first - 80);
  const end = Math.min(text.length, start + maxLen);
  const raw = text.slice(start, end);
  // collapse whitespace while keeping highlight offsets aligned
  let snippet = '';
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = /\s/.test(raw[i]) ? ' ' : raw[i];
    if (ch === ' ' && snippet.endsWith(' ')) continue;
    map[i] = snippet.length;
    snippet += ch;
  }
  const prefix = start > 0 ? '…' : '';
  const highlights = matches
    .filter((m) => m.index >= start && m.index + m[0].length <= end)
    .map((m) => [map[m.index - start] + prefix.length, map[m.index - start] + prefix.length + m[0].length]);
  return { snippet: `${prefix}${snippet}${end < text.length ? '…' : ''}`, highlights, count: matches.length, firstIndex: first };
}

function pageAt(pages, index) {
  if (index < 0 || !pages || !pages.length) return null;
  const p = pages.find((x) => index >= x.start && index < x.end);
  return p ? p.page : null;
}

function baseFilter(viewer, filters) {
  // the viewer's own documents — including their own restricted ones (core/access canView)
  const f = { userId: viewer.userId, status: { $in: ['ready', 'needs_review'] } };
  if (filters.batchId) f.batchId = filters.batchId;
  if (filters.folderId) f.folderId = filters.folderId;
  if (filters.documentType) f.documentType = filters.documentType;
  if (filters.status) f.status = { $in: [].concat(filters.status).filter((s) => ['ready', 'needs_review'].includes(s)) };
  if (filters.from || filters.to) {
    f.docCreatedAt = {};
    if (filters.from) f.docCreatedAt.$gte = new Date(filters.from);
    if (filters.to) f.docCreatedAt.$lte = new Date(filters.to);
  }
  return f;
}

const FIELDS = 'fileId fileName folderId batchId status documentType text pages docCreatedAt';

function toResult(d, terms, score) {
  const s = snippetFor(d.text, terms);
  const nameLower = (d.fileName || '').toLowerCase();
  return {
    fileId: String(d.fileId),
    fileName: d.fileName,
    folderId: d.folderId ? String(d.folderId) : null,
    batchId: d.batchId ? String(d.batchId) : null,
    status: d.status,
    documentType: d.documentType,
    createdAt: d.docCreatedAt,
    score: score ?? null,
    snippet: s.snippet,
    highlights: s.highlights,
    count: s.count,
    page: pageAt(d.pages, s.firstIndex),
    inName: terms.some((t) => nameLower.includes(t.toLowerCase())),
  };
}

async function search({ viewer, q, filters = {}, limit = 50 }) {
  // The text index must exist before a $text query (fresh databases build it on start-up).
  await SearchDoc.init();
  const query = String(q || '').trim().slice(0, 500);
  const base = baseFilter(viewer, filters);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);

  if (!query) {
    const docs = await SearchDoc.find(base).select(FIELDS).sort({ docCreatedAt: -1 }).limit(lim).lean();
    return { mode: 'recent', total: await SearchDoc.countDocuments(base), results: docs.map((d) => toResult(d, [], null)) };
  }
  const terms = highlightTerms(query);
  const textFilter = { ...base, $text: { $search: query } };
  const docs = await SearchDoc.find(textFilter, { score: { $meta: 'textScore' } })
    .select(FIELDS)
    .sort({ score: { $meta: 'textScore' } })
    .limit(lim)
    .lean();
  if (docs.length) {
    return {
      mode: 'text',
      total: await SearchDoc.countDocuments(textFilter),
      results: docs.map((d) => toResult(d, terms, Math.round(d.score * 100) / 100)),
    };
  }
  // Partial word fallback (single term, no operators)
  if (/^[^\s"-][^\s"]{1,}$/.test(query)) {
    const re = new RegExp(escapeRe(query), 'i');
    const sub = { ...base, $or: [{ text: re }, { fileName: re }] };
    const found = await SearchDoc.find(sub).select(FIELDS).sort({ docCreatedAt: -1 }).limit(lim).lean();
    return { mode: 'substring', total: await SearchDoc.countDocuments(sub), results: found.map((d) => toResult(d, [query], null)) };
  }
  return { mode: 'text', total: 0, results: [] };
}

module.exports = { search, snippetFor, highlightTerms };
