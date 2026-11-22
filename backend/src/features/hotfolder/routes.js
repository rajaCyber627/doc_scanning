// Scanner hot folder admin API (P13).
const express = require('express');
const service = require('./service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.HotFolderError) return res.status(err.status).json({ message: err.message });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong with the scanner folders' });
  }
};

router.get('/api/hotfolders', handle('hot folders', async (req, res) => res.json(await service.status(req.query.userId))));
router.put('/api/hotfolders', handle('save hot folders', async (req, res) => res.json(await service.saveProfiles(req.body.userId, req.body.profiles))));
router.post('/api/hotfolders/poll', handle('poll hot folders', async (req, res) => res.json(await service.pollNow(req.body.userId))));
router.get('/api/hotfolders/imports', handle('hot folder imports', async (req, res) => res.json(await service.recentImports(req.query.userId, req.query.limit))));

module.exports = router;
