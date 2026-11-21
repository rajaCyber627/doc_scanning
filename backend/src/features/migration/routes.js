// Migration admin API (P16): view runs and download their reports. Migrations themselves
// run from the CLI (scripts/migrate.js) — large, long-running and resumable.
const express = require('express');
const service = require('./service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.MigrationError) return res.status(err.status).json({ message: err.message });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong with the migration' });
  }
};

router.get('/api/migrations', handle('migrations', async (req, res) => res.json(await service.listRuns(req.query.userId))));
router.get('/api/migrations/:id', handle('migration', async (req, res) => res.json(await service.getRun(req.query.userId, req.params.id))));
router.get(
  '/api/migrations/:id/:kind.csv',
  handle('migration report', async (req, res) => {
    const { filename, csv } = await service.adminReport(req.query.userId, req.params.id, req.params.kind);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(csv);
  })
);

module.exports = router;
