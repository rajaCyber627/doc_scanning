// Document merging API (P12).
const express = require('express');
const { UserFacingError } = require('../../core/errors');
const service = require('./service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.MergeError) return res.status(err.status).json({ message: err.message, ...(err.details || {}) });
    if (err instanceof UserFacingError) return res.status(409).json({ message: err.message, code: err.code });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong while merging' });
  }
};

router.post('/api/merge/preview', handle('merge preview', async (req, res) => res.json(await service.preview(req.body || {}))));
router.post('/api/merge', handle('merge', async (req, res) => res.json(await service.merge(req.body || {}))));

module.exports = router;
