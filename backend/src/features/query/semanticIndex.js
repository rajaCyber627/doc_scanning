// Chunk + embed a document's text for 'Ask everything' (semantic search).
const Chunk = require('./Chunk.model');
const { embedBatch } = require('../../providers/embeddings/voyage');

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

module.exports = { chunkText, embedFile };
