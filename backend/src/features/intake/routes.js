// Intake pipeline controls.
const express = require('express');
const mongoose = require('mongoose');
const File = require('../../models/File');
const { emitAudit } = require('../../core/audit');
const { enqueueDocument } = require('./pipeline');

const router = express.Router();

// Retry a failed document: resumes at the stage that failed (the upload is not repeated).
router.post('/api/files/:id/retry', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'File not found' });
    const file = await File.findOneAndUpdate(
      { _id: req.params.id, status: 'failed' },
      { status: 'processing', error: '', errorCode: '', attempts: 0 },
      { new: true }
    ).select('-rawText -tablesCsv -words');
    if (!file) {
      const exists = await File.exists({ _id: req.params.id });
      return exists
        ? res.status(409).json({ message: 'Only failed documents can be retried' })
        : res.status(404).json({ message: 'File not found' });
    }
    await emitAudit({ userId: req.body?.userId || file.userId, action: 'pipeline.retried', documentId: file._id });
    enqueueDocument(file._id);
    res.json({ file });
  } catch (err) {
    console.error('retry error:', err && err.message);
    res.status(500).json({ message: 'Could not retry' });
  }
});

module.exports = router;
