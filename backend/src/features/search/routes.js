const express = require('express');
const router = express.Router();
const File = require('../../models/File');

// Keyword content search across all of a user's documents (name + full text)
router.get('/api/search', async (req, res) => {
  try {
    const { userId, q } = req.query;
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return res.json({ results: [] });
    const files = await File.find({ userId, status: 'ready' }).select('fileName rawText folderId');
    const results = [];
    for (const f of files) {
      const text = (f.rawText || '').toLowerCase();
      const inName = (f.fileName || '').toLowerCase().includes(needle);
      const idx = text.indexOf(needle);
      if (!inName && idx === -1) continue;
      let snippet = '';
      if (idx !== -1) {
        const raw = f.rawText || '';
        const start = Math.max(0, idx - 60);
        snippet =
          (start > 0 ? '…' : '') +
          raw.slice(start, idx + needle.length + 90).replace(/\s+/g, ' ').trim() +
          '…';
      }
      let count = 0;
      let i = 0;
      while (count < 999) {
        const j = text.indexOf(needle, i);
        if (j === -1) break;
        count++;
        i = j + needle.length;
      }
      results.push({ fileId: f._id, fileName: f.fileName, folderId: f.folderId || null, count, snippet, inName });
      if (results.length >= 100) break;
    }
    results.sort((a, b) => b.count - a.count);
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
