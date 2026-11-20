// Full-text search over processed documents (P07).
// GET /api/search?userId=&q=&batchId=&folderId=&status=&documentType=&from=&to=&limit=
//   q supports words (stemmed), "exact phrases" and -excluded words.
// Restricted documents are left out — and not counted — for users without permission.
const express = require('express');
const mongoose = require('mongoose');
const { viewerFor } = require('../../core/access');
const { getSearchProvider } = require('../../providers/search');

const router = express.Router();
const id = (v) => (v && mongoose.isValidObjectId(v) ? v : undefined);
const date = (v) => (v && !Number.isNaN(Date.parse(v)) ? v : undefined);

router.get('/api/search', async (req, res) => {
  try {
    const viewer = await viewerFor(req.query.userId);
    if (!viewer) return res.status(400).json({ message: 'A valid userId is required' });
    const { q, limit } = req.query;
    const filters = {
      batchId: id(req.query.batchId),
      folderId: id(req.query.folderId),
      documentType: req.query.documentType ? String(req.query.documentType) : undefined,
      status: req.query.status ? String(req.query.status).split(',') : undefined,
      from: date(req.query.from),
      to: date(req.query.to),
    };
    res.json(await getSearchProvider().search({ viewer, q, filters, limit }));
  } catch (err) {
    console.error('search error:', err && err.message);
    res.status(500).json({ message: 'Search is unavailable right now' });
  }
});

module.exports = router;
