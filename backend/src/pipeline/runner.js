// Runs a document through the pipeline stages with retries, recording progress
// on the document so it can resume after a restart.
const File = require('../models/File');
const config = require('../config');
const { s3GetBuffer } = require('../services/storage');
const { emitAudit } = require('../audit');
const { humanizeError } = require('./errors');
const { STAGES } = require('./stages');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => config.pipeline.backoffBaseMs * 4 ** (attempt - 1);

/**
 * @param {string} fileId
 * @param {object} [opts]
 * @param {Buffer} [opts.buffer]  file bytes if already in memory (avoids an S3 download)
 * @param {Array}  [opts.stages]  override the stage list (tests)
 * @returns {Promise<'ready'|'failed'|'missing'>}
 */
async function runPipeline(fileId, { buffer = null, stages = STAGES } = {}) {
  let file = await File.findById(fileId);
  if (!file) return 'missing';

  let cached = buffer;
  const ctx = {
    get file() {
      return file;
    },
    async getBuffer() {
      if (!cached) cached = await s3GetBuffer(file.s3Key);
      return cached;
    },
  };

  const done = new Set((file.stageHistory || []).filter((h) => h.status === 'done').map((h) => h.stage));

  for (const stage of stages) {
    if (done.has(stage.name)) continue;

    // All blocking stages finished → the document is usable now.
    if (!stage.blocking && file.status !== 'ready') {
      file = await markReady(file);
      if (!file) return 'missing';
    }

    const result = await runStage(file, stage, ctx);
    if (result.file === null) return 'missing'; // deleted while processing
    file = result.file;

    if (!result.ok && stage.blocking) {
      await File.updateOne(
        { _id: file._id },
        { status: 'failed', error: result.error.message, errorCode: result.error.code }
      );
      await emitAudit({
        userId: file.userId,
        action: 'pipeline.failed',
        documentId: file._id,
        details: { stage: stage.name, code: result.error.code, error: result.error.message },
      });
      return 'failed';
    }
  }

  if (file.status !== 'ready') file = await markReady(file);
  if (file) await File.updateOne({ _id: file._id }, { stage: 'done', attempts: 0 });
  return 'ready';
}

async function markReady(file) {
  const updated = await File.findByIdAndUpdate(
    file._id,
    { status: 'ready', error: '', errorCode: '' },
    { new: true }
  );
  if (updated) {
    await emitAudit({ userId: updated.userId, action: 'document.ready', documentId: updated._id });
  }
  return updated;
}

async function runStage(file, stage, ctx) {
  const { maxAttempts } = config.pipeline;
  const startedAt = new Date();
  let error = null;
  let lastAttempt = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastAttempt = attempt;
    await File.updateOne({ _id: file._id }, { stage: stage.name, attempts: attempt });
    try {
      const updates = (await stage.run(ctx)) || {};
      const saved = await File.findByIdAndUpdate(
        file._id,
        {
          ...updates,
          $push: {
            stageHistory: { stage: stage.name, status: 'done', attempts: attempt, startedAt, finishedAt: new Date() },
          },
        },
        { new: true }
      );
      return { ok: true, file: saved };
    } catch (err) {
      error = humanizeError(err);
      console.error(`pipeline ${stage.name} failed (attempt ${attempt}/${maxAttempts}) for ${file._id}:`, error.raw);
      if (!error.retryable || attempt === maxAttempts) break;
      await sleep(backoffMs(attempt));
    }
  }

  const saved = await File.findByIdAndUpdate(
    file._id,
    {
      $push: {
        stageHistory: {
          stage: stage.name,
          status: 'failed',
          attempts: lastAttempt,
          startedAt,
          finishedAt: new Date(),
          error: error.message,
        },
      },
    },
    { new: true }
  );
  if (saved && !stage.blocking) {
    await emitAudit({
      userId: saved.userId,
      action: 'pipeline.stage_failed',
      documentId: saved._id,
      details: { stage: stage.name, code: error.code, error: error.message },
    });
  }
  return { ok: false, file: saved, error };
}

module.exports = { runPipeline };
