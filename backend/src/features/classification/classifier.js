// Ask Claude to classify one document against the HR taxonomy. Structured output
// (JSON Schema) keeps the answer machine-readable; the result is still validated here.
// Document text is never logged.
const { anthropic } = require('../../providers/llm/client');
const config = require('../../core/config');
const { hintText } = require('../emailintake/hints');

const CONF_LEVELS = ['General', 'Confidential', 'Restricted'];
const nullable = (type) => ({ type: [type, 'null'] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['documentType', 'confidentialityLevel', 'restrictedLikely', 'person', 'fields', 'confidence'],
  properties: {
    documentType: nullable('string'),
    confidentialityLevel: { type: 'string', enum: CONF_LEVELS },
    restrictedLikely: { type: 'boolean' },
    person: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'employeeId', 'applicantNumber', 'quote', 'page'],
      properties: {
        name: nullable('string'),
        employeeId: nullable('string'),
        applicantNumber: nullable('string'),
        quote: nullable('string'),
        page: nullable('integer'),
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'quote', 'page', 'confidence'],
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
          quote: nullable('string'),
          page: nullable('integer'),
          confidence: { type: 'number' },
        },
      },
    },
    confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['documentType', 'person', 'confidentiality'],
      properties: { documentType: { type: 'number' }, person: { type: 'number' }, confidentiality: { type: 'number' } },
    },
  },
};

function systemPrompt(taxonomy, fieldGuide) {
  const types = taxonomy.documentTypes
    .map((t) => {
      const cat = taxonomy.categories.find((c) => c.key === t.categoryKey);
      return `${t.key} | ${cat ? cat.name : t.categoryKey} | ${t.name}`;
    })
    .join('\n');
  return `You classify documents for a city Human Resources department so staff can file them.

Pick the single best document type from this list (key | category | name). Use the key exactly as written, or null if none fits:
${types}

Confidentiality: medical, FMLA/leave, ADA/accommodation and workers' compensation records, employee-relations investigations and grievances are Restricted. Set restrictedLikely to true whenever the document might contain medical or other restricted information, even if you are unsure — it is used to protect the record before anyone sees it.

Not every document is about one employee: requests for proposals, contracts, policies, newsletters, capability statements, letters to the City, blank forms and other reference material belong in the "general." types — choose the closest one (general.reference-documents when nothing else fits) and leave the person empty. Use null only when the text is unreadable.

Person: the employee or applicant the document is about (not the author or a manager), with their employee ID or applicant number when the text shows one.

Fields: fill only fields that apply to the chosen type and are stated in the text. Known fields:
${fieldGuide}
Dates as YYYY-MM-DD, numbers as plain digits.

Evidence: every quote must be copied exactly from the document text (a short phrase), with its page number when page markers are present. Never invent values.

Confidence: a number from 0 to 1 for each judgement; use lower values when the text is unclear or the choice is a guess.`;
}

/** Document text with page markers, whole pages first, within the size limit. */
function documentText(pages, rawText) {
  const max = config.classification.maxTextChars;
  let out = '';
  let truncated = false;
  const segs = pages && pages.length ? pages.map((p) => ({ page: p.page, text: p.text })) : [{ page: 1, text: rawText || '' }];
  for (const s of segs) {
    const block = `[Page ${s.page}]\n${s.text}\n`;
    if (out.length + block.length > max) {
      out += block.slice(0, Math.max(0, max - out.length));
      truncated = true;
      break;
    }
    out += block;
  }
  return { text: out, truncated };
}

const clamp = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Shape check of the model's answer (structured output should guarantee it; trust nothing). */
function validateAnswer(a) {
  if (!a || typeof a !== 'object') return 'not an object';
  if (!CONF_LEVELS.includes(a.confidentialityLevel)) return 'bad confidentialityLevel';
  if (typeof a.restrictedLikely !== 'boolean') return 'bad restrictedLikely';
  if (!a.person || typeof a.person !== 'object') return 'missing person';
  if (!Array.isArray(a.fields)) return 'missing fields';
  if (!a.confidence || typeof a.confidence !== 'object') return 'missing confidence';
  if (a.documentType !== null && typeof a.documentType !== 'string') return 'bad documentType';
  return null;
}

class ClassificationFailed extends Error {}

async function callModel({ system, text, hints = '' }) {
  const response = await anthropic.beta.messages.create({
    model: config.models.classify,
    max_tokens: 4000,
    // Server-side fallback: if the model declines, the API re-runs on a fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: config.classification.effort, format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `${hints}Classify this document.\n\n<document>\n${text}\n</document>` }],
  });
  if (response.stop_reason === 'refusal') throw new ClassificationFailed('The AI declined to classify this document');
  if (response.stop_reason === 'max_tokens') throw new ClassificationFailed('The AI answer was cut off');
  const block = (response.content || []).find((b) => b.type === 'text');
  let answer;
  try {
    answer = JSON.parse(block ? block.text : '');
  } catch {
    throw new ClassificationFailed('The AI answer was not valid JSON');
  }
  const problem = validateAnswer(answer);
  if (problem) throw new ClassificationFailed(`The AI answer was incomplete (${problem})`);
  return { answer, model: response.model || config.models.classify };
}

/**
 * Classify a document. Retries once on an invalid answer.
 * @returns {{ answer, model, truncated }}
 */
async function classify({ taxonomy, fieldGuide, pages, rawText, hints = null }) {
  const system = systemPrompt(taxonomy, fieldGuide);
  const { text, truncated } = documentText(pages, rawText);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { answer, model } = await callModel({ system, text, hints: hintText(hints) });
      answer.confidence = {
        documentType: clamp(answer.confidence.documentType),
        person: clamp(answer.confidence.person),
        confidentiality: clamp(answer.confidence.confidentiality),
      };
      answer.fields = answer.fields.filter((f) => f && typeof f.key === 'string').map((f) => ({ ...f, confidence: clamp(f.confidence) }));
      return { answer, model, truncated };
    } catch (e) {
      if (!(e instanceof ClassificationFailed)) throw e; // API errors: let the pipeline retry
      lastError = e;
    }
  }
  throw lastError;
}

module.exports = { classify, documentText, validateAnswer, SCHEMA, ClassificationFailed };
