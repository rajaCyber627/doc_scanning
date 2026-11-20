// Intake pipeline controls.
const express = require('express');
const mongoose = require('mongoose');
const File = require('../../models/File');
const { emitAudit } = require('../../core/audit');
const { enqueueDocument } = require('./pipeline');
const events = require('../../core/events');

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
    if (file.batchId) events.emit('batch.touch', String(file.batchId));
    res.json({ file });
  } catch (err) {
    console.error('retry error:', err && err.message);
    res.status(500).json({ message: 'Could not retry' });
  }
});

// A person checked a "needs review" document and accepts it as it is.
router.post('/api/files/:id/review', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'File not found' });
    const current = await File.findById(req.params.id).select('status reviewReasons userId batchId');
    if (!current) return res.status(404).json({ message: 'File not found' });
    if (current.status !== 'needs_review') return res.status(409).json({ message: 'This document is not waiting for review' });
    const userId = mongoose.isValidObjectId(req.body?.userId) ? req.body.userId : null;
    const file = await File.findByIdAndUpdate(
      current._id,
      {
        status: 'ready',
        reviewReasons: [],
        $push: { resolvedReviewReasons: { $each: current.reviewReasons.map((r) => ({ ...r, resolvedAt: new Date(), resolvedBy: userId })) } },
        reviewedAt: new Date(),
        reviewedBy: userId,
      },
      { new: true }
    ).select('-rawText -tablesCsv -words');
    await emitAudit({
      userId: userId || current.userId,
      action: 'document.reviewed',
      documentId: current._id,
      details: { reasons: current.reviewReasons.map((r) => r.code), note: String(req.body?.note || '').slice(0, 500) },
    });
    if (current.batchId) events.emit('batch.touch', String(current.batchId));
    res.json({ file });
  } catch (err) {
    console.error('review error:', err && err.message);
    res.status(500).json({ message: 'Could not save the review' });
  }
});

module.exports = router;
