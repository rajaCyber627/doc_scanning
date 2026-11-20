// Voyage embeddings + chunking for semantic search (moved verbatim from app.js).
const axios = require('axios');
const Chunk = require('../models/Chunk');

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

function chunkText(text, size = 2000, overlap = 200) {
  const clean = String(text || '').trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    const piece = clean.slice(i, i + size).trim();
    if (piece) chunks.push(piece);
    if (i + size >= clean.length) break;
    if (chunks.length >= 300) break;
  }
  return chunks;
}

// Best-effort: (re)build a file's chunk embeddings. Never throws, and stops
// early if Bedrock isn't available yet (IAM/access pending).
async function embedFile(file) {
  try {
    if (!file || !file.rawText) return 0;
    await Chunk.deleteMany({ fileId: file._id });
    const pieces = chunkText(file.rawText);
    let idx = 0;
    const B = 20;
    for (let b = 0; b < pieces.length; b += B) {
      const batch = pieces.slice(b, b + B);
      let embs;
      try {
        embs = await embedBatch(batch);
      } catch (e) {
        console.error('embed error:', e && e.message);
        return idx;
      }
      for (let j = 0; j < batch.length; j++) {
        await Chunk.create({
          userId: file.userId,
          fileId: file._id,
          fileName: file.fileName,
          folderId: file.folderId || null,
          chunkIndex: idx++,
          text: batch[j],
          embedding: embs[j],
        });
      }
    }
    return idx;
  } catch (e) {
    console.error('embedFile error:', e && e.message);
    return 0;
  }
}

module.exports = { VOYAGE_MODEL, voyageEmbed, embed, embedBatch, chunkText, embedFile };
