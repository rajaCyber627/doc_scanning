const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const File = require('../../models/File');
const Chunk = require('./Chunk.model');
const userModel = require('../../models/User');
const { askClaude, validateAnswer } = require('./answering');
const { embed } = require('../../providers/embeddings/voyage');

// Query across a selection of files (multi-file). NOT saved.
const MAX_QUERY_CHARS = 300000; // ~75k tokens budget across the selection
router.post('/api/query', async (req, res) => {
  try {
    const { fileIds, query } = req.body;
    if (!query || !String(query).trim()) return res.status(400).json({ message: 'Query is required' });
    if (!Array.isArray(fileIds) || !fileIds.length)
      return res.status(400).json({ message: 'Select at least one file' });

    const files = await File.find({ _id: { $in: fileIds }, status: 'ready' });
    if (!files.length) return res.status(400).json({ message: 'No ready files in the selection' });

    let combined = '';
    const skipped = [];
    for (const f of files) {
      const block = `\n===== FILE: ${f.fileName} =====\n${f.rawText || ''}\n`;
      if (combined.length + block.length > MAX_QUERY_CHARS) {
        skipped.push(f.fileName);
        continue;
      }
      combined += block;
    }

    const u2 = await userModel.findById(files[0].userId).select('customInstructions').catch(() => null);
    const raw = await askClaude(combined, '', query, u2 && u2.customInstructions);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { answer: raw };
    }
    const validation = await validateAnswer(combined, query, data);
    res.json({ query, data, validation, filesUsed: files.length - skipped.length, skipped });
  } catch (err) {
    console.error('multi-query error:', err && err.message);
    res.status(500).json({ message: 'Failed to generate answer' });
  }
});

// Global semantic search: ask a question across ALL of a user's documents (RAG)
router.post('/api/ask', async (req, res) => {
  try {
    const { userId, question } = req.body;
    if (!userId || !question || !String(question).trim())
      return res.status(400).json({ message: 'Question is required' });

    let qEmb;
    try {
      qEmb = await embed(question, 'query');
    } catch (e) {
      console.error('embed (ask) error:', e && e.message);
      return res.status(502).json({ message: 'Semantic search is temporarily unavailable.' });
    }

    let hits = [];
    try {
      hits = await Chunk.aggregate([
        {
          $vectorSearch: {
            index: 'vector_index',
            path: 'embedding',
            queryVector: qEmb,
            numCandidates: 120,
            limit: 8,
            filter: { userId: new mongoose.Types.ObjectId(String(userId)) },
          },
        },
        { $project: { text: 1, fileId: 1, fileName: 1, score: { $meta: 'vectorSearchScore' } } },
      ]);
    } catch (e) {
      console.error('vectorSearch error:', e && e.message);
      return res.status(502).json({ message: 'The search index is not ready yet.' });
    }

    if (!hits.length)
      return res.json({
        data: { note: 'No relevant content found across your documents yet.' },
        sources: [],
        validation: null,
      });

    const context = hits.map((h) => `===== FILE: ${h.fileName} =====\n${h.text}`).join('\n\n');
    const u = await userModel.findById(userId).select('customInstructions').catch(() => null);
    const raw = await askClaude(context, '', question, u && u.customInstructions);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { answer: raw };
    }
    const validation = await validateAnswer(context, question, data);

    const seen = new Set();
    const sources = [];
    for (const h of hits) {
      const idStr = String(h.fileId);
      if (!seen.has(idStr)) {
        seen.add(idStr);
        sources.push({ fileId: h.fileId, fileName: h.fileName });
      }
    }
    res.json({ data, sources, validation });
  } catch (err) {
    console.error('ask error:', err && err.message);
    res.status(500).json({ message: 'Failed to answer' });
  }
});

// Generate a table for a query — NOT saved (returned for the user to confirm/keep)
router.post('/api/files/:id/query', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || !String(query).trim()) return res.status(400).json({ message: 'Query is required' });
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ message: 'File not found' });
    if (file.status !== 'ready') return res.status(400).json({ message: 'File is still being processed' });

    const u1 = await userModel.findById(file.userId).select('customInstructions').catch(() => null);
    const raw = await askClaude(file.rawText, file.tablesCsv, query, u1 && u1.customInstructions);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { answer: raw };
    }
    const validation = await validateAnswer(file.rawText, query, data);
    res.json({ query, data, validation });
  } catch (err) {
    console.error('query error:', err && err.message);
    res.status(500).json({ message: 'Failed to generate answer' });
  }
});

module.exports = router;
