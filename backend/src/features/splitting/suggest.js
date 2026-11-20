// AI-suggested split points: from the per-page text and the taxonomy, where does a new
// document start, and why ("page 4 starts a new form: Benefit elections").
const { anthropic } = require('../../providers/llm/client');
const config = require('../../core/config');

const PER_PAGE_CHARS = 1200; // the top of a page is what tells a new document apart
const MAX_PAGES = 200;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['documents'],
  properties: {
    documents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['startPage', 'documentType', 'reason', 'confidence'],
        properties: {
          startPage: { type: 'integer' },
          documentType: { type: ['string', 'null'] },
          reason: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

function system(taxonomy) {
  const types = taxonomy.documentTypes.map((t) => `${t.key} | ${t.name}`).join('\n');
  return `You separate a scanned bundle of city Human Resources paperwork into its individual documents.

You get the text of every page, marked [Page n]. List each document in the bundle in page order with the page it starts on. A new document usually starts where a new form, letter or title begins, a different person is named, or the page numbering restarts ("Page 1 of 2"). Continuation pages (page 2 of a letter, the back of a form) belong to the document before them. If the whole file is one document, return a single entry starting on page 1.

For each document give the best matching document type key from this list (key | name), or null:
${types}

reason: one short sentence a records clerk understands, quoting what on the start page shows a new document begins (e.g. "Page 4 starts a new form: 'Benefit Election Form 2026'").
confidence: 0 to 1 that a new document really starts on that page.`;
}

function pagesText(pages) {
  return pages
    .slice(0, MAX_PAGES)
    .map((p) => `[Page ${p.page}]\n${String(p.text || '').slice(0, PER_PAGE_CHARS) || '(blank page)'}`)
    .join('\n\n');
}

class SuggestFailed extends Error {}

async function callModel(taxonomy, pages) {
  const response = await anthropic.beta.messages.create({
    model: config.models.classify,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: config.classification.effort, format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: system(taxonomy), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Where does each document start?\n\n<pages>\n${pagesText(pages)}\n</pages>` }],
  });
  if (response.stop_reason === 'refusal') throw new SuggestFailed('The AI declined to read this document');
  if (response.stop_reason === 'max_tokens') throw new SuggestFailed('The AI answer was cut off');
  const block = (response.content || []).find((b) => b.type === 'text');
  let a;
  try {
    a = JSON.parse(block ? block.text : '');
  } catch {
    throw new SuggestFailed('The AI answer was not valid JSON');
  }
  if (!a || !Array.isArray(a.documents)) throw new SuggestFailed('The AI answer was incomplete');
  return { answer: a, model: response.model || config.models.classify };
}

/**
 * Normalise the model's answer into cuts: page numbers where a new part starts (> 1),
 * each with the reason, a type suggestion and confidence for the part that starts there.
 * Invalid / out-of-range / duplicate pages are dropped.
 * @returns {{ cuts: [{ page, reason, confidence }], parts: [{ from, to, documentType, reason, confidence }], model }}
 */
function normalise(answer, pageCount, taxonomy) {
  const known = new Set(taxonomy.documentTypes.map((t) => t.key));
  const clamp = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  const starts = new Map();
  for (const d of answer.documents) {
    const p = Number(d && d.startPage);
    if (!Number.isInteger(p) || p < 1 || p > pageCount || starts.has(p)) continue;
    starts.set(p, {
      documentType: d.documentType && known.has(d.documentType) ? d.documentType : null,
      reason: String(d.reason || '').slice(0, 300),
      confidence: clamp(d.confidence),
    });
  }
  if (!starts.has(1)) starts.set(1, { documentType: null, reason: 'Start of the file', confidence: 1 });
  const ordered = [...starts.keys()].sort((a, b) => a - b);
  const parts = ordered.map((from, i) => ({ from, to: (ordered[i + 1] || pageCount + 1) - 1, ...starts.get(from) }));
  const cuts = parts.slice(1).map((p) => ({ page: p.from, reason: p.reason, confidence: p.confidence }));
  return { cuts, parts };
}

async function suggestSplits({ taxonomy, pages }) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { answer, model } = await callModel(taxonomy, pages);
      return { ...normalise(answer, pages.length, taxonomy), model, truncated: pages.length > MAX_PAGES };
    } catch (e) {
      if (!(e instanceof SuggestFailed)) throw e;
      last = e;
    }
  }
  throw last;
}

module.exports = { suggestSplits, normalise, SuggestFailed, SCHEMA };
