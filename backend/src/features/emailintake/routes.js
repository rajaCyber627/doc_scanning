// Email intake admin API (P15).
const express = require('express');
const service = require('./service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.EmailIntakeError) return res.status(err.status).json({ message: err.message });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong with email intake' });
  }
};

router.get('/api/email-intake', handle('email intake', async (req, res) => res.json(await service.status(req.query.userId))));
router.put('/api/email-intake', handle('save email intake', async (req, res) => res.json(await service.saveSettings(req.body.userId, req.body.settings || {}))));
router.post('/api/email-intake/poll', handle('poll email', async (req, res) => res.json(await service.pollNow(req.body.userId))));
router.get('/api/email-intake/log', handle('email log', async (req, res) => res.json(await service.recentLog(req.query.userId, req.query.limit))));

module.exports = router;
