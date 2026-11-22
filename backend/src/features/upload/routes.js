// Upload API (P02). Flow: POST /api/uploads → send bytes (S3 URL(s) or PUT .../content)
// → POST /api/uploads/:id/complete. See docs/capture/uploads.md.
const express = require('express');
const service = require('./service');

const router = express.Router();

function sendError(res, err, label) {
  if (err instanceof service.UploadError) {
    return res.status(err.status).json({ message: err.message, code: err.code });
  }
  console.error(`${label}:`, err && err.message);
  return res.status(500).json({ message: 'Upload failed — please try again', code: 'SERVER_ERROR' });
}

// Accepted types, size limits, transport — the client's single source of truth.
router.get('/api/uploads/config', (req, res) => res.json(service.uploadConfig()));

router.post('/api/uploads', async (req, res) => {
  try {
    res.status(201).json(await service.createSession(req.body || {}));
  } catch (err) {
    sendError(res, err, 'create upload');
  }
});

// Proxy transport (used when the bucket blocks direct browser uploads).
router.put('/api/uploads/:id/content', async (req, res) => {
  try {
    res.json(await service.receiveProxyContent(req.params.id, req.query.userId, req));
  } catch (err) {
    sendError(res, err, 'proxy upload');
  }
});

router.post('/api/uploads/:id/complete', async (req, res) => {
  try {
    const file = await service.completeSession(req.params.id, req.body || {});
    res.status(201).json({ file });
  } catch (err) {
    sendError(res, err, 'complete upload');
  }
});

router.post('/api/uploads/:id/abort', async (req, res) => {
  try {
    res.json(await service.abortSession(req.params.id, req.body || {}));
  } catch (err) {
    sendError(res, err, 'abort upload');
  }
});

module.exports = router;
