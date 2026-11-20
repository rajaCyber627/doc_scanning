// AI overview of a document: summary, key facts, suggested questions.
const { anthropic } = require('../../providers/llm/client');
const config = require('../../core/config');

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

module.exports = { generateOverview };
