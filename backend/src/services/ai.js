// Claude calls: answers, validation, overview (moved verbatim from app.js).
const { anthropic } = require('../clients');
const config = require('../config');

// ---------------------------------------------------------------------------
// Claude: document text + a user question -> a single JSON object
// ---------------------------------------------------------------------------
async function askClaude(rawText, tablesCsv, query, instructions) {
  const prompt = `You are given the extracted contents of one or more documents. When
multiple documents are present they are separated by lines like "===== FILE: name =====".

CONTENT:
${rawText}
${tablesCsv ? `\nDETECTED TABLES (CSV):\n${tablesCsv}\n` : ''}
Answer the user's request using ONLY the information in these documents. When the request
spans multiple documents (totals, comparisons, counts), aggregate across all of them.
Represent the answer as a single JSON object. For tabular answers use an array of objects
with consistent keys. If the documents do not contain the answer, return {"note": "..."}.
${instructions ? `\nThe user has standing instructions — follow them when they don't conflict with the document:\n${instructions}\n` : ''}
User request: ${query}`;

  const response = await anthropic.messages.create({
    model: config.models.main,
    max_tokens: 16000,
    system:
      'You extract structured data from documents and always respond with a single valid JSON object only — no markdown, no code fences, no text before or after the JSON.',
    messages: [{ role: 'user', content: prompt }],
  });
  const block = response.content.find((b) => b.type === 'text');
  let text = block ? block.text.trim() : '';
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

// One-level validation: a cheap, fast grounding check that the generated answer
// is actually supported by the source. Returns null if the check itself fails
// (never blocks the answer).
async function validateAnswer(sourceText, query, data) {
  try {
    const prompt = `A user asked: "${query}"

A system generated this JSON answer from the document(s):
${JSON.stringify(data).slice(0, 8000)}

Check the answer against the DOCUMENT below and reply with ONE JSON object:
{"status":"verified|partial|unsupported","note":"one short sentence"}
- verified: the answer's key facts are clearly supported by the document.
- partial: some parts are supported, others are missing or uncertain.
- unsupported: the answer is not supported (likely hallucinated) or absent from the document.

DOCUMENT:
${(sourceText || '').slice(0, 30000)}`;
    const response = await anthropic.messages.create({
      model: config.models.fast,
      max_tokens: 200,
      system: 'You are a strict fact-checker. Reply with a single valid JSON object only.',
      messages: [{ role: 'user', content: prompt }],
    });
    const block = response.content.find((b) => b.type === 'text');
    let text = block ? block.text.trim() : '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(text);
    const status = ['verified', 'partial', 'unsupported'].includes(parsed.status)
      ? parsed.status
      : 'partial';
    return { status, note: String(parsed.note || '').slice(0, 240) };
  } catch (e) {
    console.error('validation error:', e && e.message);
    return null;
  }
}

// After Textract, ask Claude for a summary, key facts, and suggested questions.
async function generateOverview(rawText, tablesCsv) {
  const prompt = `You are given a document's extracted contents. Return a single JSON object with exactly these keys:
- "summary": a 2-3 sentence plain-language description of what this document is.
- "keyFacts": an array of up to 6 objects {"label","value"} capturing the most important facts.
- "suggestedQuestions": an array of 4-6 short, useful questions a user could ask to pull structured tables out of this document.
JSON only.

TEXT:
${(rawText || '').slice(0, 60000)}

TABLES (CSV):
${(tablesCsv || '').slice(0, 20000)}`;
  const response = await anthropic.messages.create({
    model: config.models.main,
    max_tokens: 2000,
    system:
      'Respond with a single valid JSON object only — no markdown, no code fences, no text before or after.',
    messages: [{ role: 'user', content: prompt }],
  });
  const block = response.content.find((b) => b.type === 'text');
  let text = block ? block.text.trim() : '';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

module.exports = { askClaude, validateAnswer, generateOverview };
