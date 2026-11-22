// Duplicate review API (P08).
const express = require('express');
const service = require('./service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.DuplicateError) return res.status(err.status).json({ message: err.message });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong with the duplicate check' });
  }
};

// What this document duplicates (for the side-by-side compare view).
router.get(
  '/api/files/:id/duplicates',
  handle('duplicates', async (req, res) => res.json(await service.describeMatches(req.params.id, req.query.userId)))
);

// { userId, action: keep_both | replace | discard, reason }
router.post(
  '/api/files/:id/duplicate-decision',
  handle('duplicate decision', async (req, res) => res.json(await service.decide(req.params.id, req.body || {})))
);

// Same decision for every open duplicate in a batch.
router.post(
  '/api/batches/:id/duplicate-decision',
  handle('batch duplicate decision', async (req, res) => res.json(await service.decideBatch(req.params.id, req.body || {})))
);

module.exports = router;
