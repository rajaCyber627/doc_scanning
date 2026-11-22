// Voyage AI embeddings provider.
const axios = require('axios');

// Voyage AI embeddings — voyage-4-lite at output_dimension 1024 (matches the
// Atlas index; 200M free tokens on the voyage-4 generation). Batches per
// request and retries on 429 (rate limits).
const VOYAGE_MODEL = 'voyage-4-lite';
async function voyageEmbed(inputs, inputType = 'document') {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await axios.post(
        'https://api.voyageai.com/v1/embeddings',
        { input: inputs, model: VOYAGE_MODEL, input_type: inputType, output_dimension: 1024 },
        {
          headers: {
            Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );
      return res.data.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (e) {
      const code = e.response && e.response.status;
      if (code === 429 && attempt < 10) {
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      throw e;
    }
  }
}
async function embed(text, inputType = 'document') {
  const [v] = await voyageEmbed([String(text || '').slice(0, 8000)], inputType);
  return v;
}
async function embedBatch(texts, inputType = 'document') {
  return voyageEmbed(
    texts.map((t) => String(t || '').slice(0, 8000)),
    inputType
  );
}

module.exports = { VOYAGE_MODEL, voyageEmbed, embed, embedBatch };
