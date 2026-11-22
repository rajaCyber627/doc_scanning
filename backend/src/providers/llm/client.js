// Anthropic (Claude) client. Model IDs live in core/config (config.models).
// Tests replace this module with a fake.
const Anthropic = require('@anthropic-ai/sdk');
require('../../core/config');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = { anthropic };
