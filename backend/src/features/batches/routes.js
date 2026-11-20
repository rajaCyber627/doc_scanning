// Intake batches API (P03).
const express = require('express');
const service = require('./service');

const router = express.Router();

const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.BatchError) return res.status(err.status).json({ message: err.message });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong with this batch' });
  }
};

const userOf = (req) => (req.body && req.body.userId) || req.query.userId;

router.post('/api/batches', handle('create batch', async (req, res) => res.status(201).json(await service.createBatch(req.body || {}))));
router.get('/api/batches', handle('list batches', async (req, res) => res.json(await service.listBatches(req.query.userId))));
router.get('/api/batches/:id', handle('get batch', async (req, res) => res.json(await service.getBatch(req.params.id, userOf(req)))));
router.post('/api/batches/:id/close', handle('close batch', async (req, res) => res.json(await service.closeBatch(req.params.id, userOf(req)))));
router.post(
  '/api/batches/:id/retry-failed',
  handle('retry batch', async (req, res) => res.json(await service.retryFailed(req.params.id, userOf(req))))
);
router.post(
  '/api/batches/:id/cancel-unfinished',
  handle('cancel batch items', async (req, res) =>
    res.json(await service.cancelUnfinished(req.params.id, userOf(req), req.body && req.body.indexes))
  )
);
router.get(
  '/api/batches/:id/report.csv',
  handle('batch report', async (req, res) => {
    const { filename, csv } = await service.reportCsv(req.params.id, userOf(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(csv);
  })
);

module.exports = router;
