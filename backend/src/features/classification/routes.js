// Classification review API (P10).
const express = require('express');
const service = require('./service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.ClassificationError) return res.status(err.status).json({ message: err.message });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong with the review' });
  }
};

router.get('/api/review-queue', handle('review queue', async (req, res) => res.json(await service.queue(req.query.userId, req.query.queue))));
router.post(
  '/api/files/:id/classification/accept',
  handle('accept classification', async (req, res) => res.json(await service.accept(req.params.id, req.body || {})))
);
router.post(
  '/api/files/:id/classification/reassign',
  handle('reassign classification', async (req, res) => res.json(await service.reassign(req.params.id, req.body || {})))
);
router.get('/api/settings/classification', handle('ai settings', async (req, res) => res.json(await service.getSettings())));
router.put(
  '/api/settings/classification',
  handle('save ai settings', async (req, res) => res.json(await service.saveSettings(req.body.userId, req.body.settings || {})))
);
router.get('/api/classification/accuracy', handle('accuracy', async (req, res) => res.json(await service.accuracy(req.query.userId))));

module.exports = router;
