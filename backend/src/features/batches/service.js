// Intake batches: create with the list of selected files, track every file from
// "not uploaded" to "ready", retry failures, cancel unfinished files, report as CSV.
const mongoose = require('mongoose');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const Batch = require('../../models/Batch');
const File = require('../../models/File');
const Folder = require('../../models/Folder');
const User = require('../../models/User');
const UploadSession = require('../upload/UploadSession.model');
const { abortSession } = require('../upload/service');
const { enqueueDocument } = require('../intake/pipeline');

const MAX_ITEMS = 2000;

class BatchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isId = (v) => !!v && mongoose.isValidObjectId(v);
const FINAL_ITEM_STATES = new Set(['ready', 'needs_review', 'failed', 'upload_failed', 'cancelled']);

async function loadOwned(batchId, userId) {
  if (!isId(batchId)) throw new BatchError(404, 'Batch not found');
  const batch = await Batch.findById(batchId);
  if (!batch || !userId || String(batch.createdBy) !== String(userId)) throw new BatchError(404, 'Batch not found');
  return batch;
}

function defaultName(user) {
  const when = new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const who = (user && (user.firstName || user.userName || user.email)) || 'user';
  return `Upload · ${when} · ${who}`;
}

async function createBatch({ userId, name, folderId, source, items }) {
  if (!isId(userId)) throw new BatchError(400, 'A valid userId is required');
  const user = await User.findById(userId).select('firstName userName email').lean();
  if (!user) throw new BatchError(400, 'A valid userId is required');
  if (!Array.isArray(items) || items.length === 0) throw new BatchError(400, 'A batch needs at least one file');
  if (items.length > MAX_ITEMS) throw new BatchError(400, `A batch can hold at most ${MAX_ITEMS} files`);
  const clean = items.map((it) => ({
    name: String((it && it.name) || '').slice(0, 300),
    size: Number(it && it.size),
    path: String((it && it.path) || '').slice(0, 1000),
  }));
  if (clean.some((it) => !it.name || !Number.isFinite(it.size) || it.size < 0))
    throw new BatchError(400, 'Each file needs a name and a size');
  if (folderId) {
    if (!isId(folderId)) throw new BatchError(400, 'Invalid folderId');
    const folder = await Folder.findById(folderId).select('userId').lean();
    if (!folder || String(folder.userId) !== String(userId)) throw new BatchError(404, 'Folder not found');
  }
  const batch = await Batch.create({
    name: (name && String(name).trim().slice(0, 200)) || defaultName(user),
    source: ['upload', 'camera', 'scanner', 'email', 'import'].includes(source) ? source : 'upload',
    createdBy: userId,
    folderId: folderId || null,
    items: clean,
    counts: { total: clean.length, notUploaded: clean.length },
  });
  await emitAudit({
    userId,
    action: 'batch.created',
    details: { batchId: String(batch._id), name: batch.name, files: clean.length, folderId: folderId || null },
  });
  return summary(batch);
}

/** Per-file state, combining the selected-file list, upload sessions and documents. */
async function itemStates(batch) {
  const [docs, sessions] = await Promise.all([
    File.find({ batchId: batch._id })
      .select('fileName status stage error errorCode sizeBytes batchItem createdAt')
      .sort({ createdAt: 1 })
      .lean(),
    UploadSession.find({ batchId: batch._id }).select('status error hints createdAt').sort({ createdAt: 1 }).lean(),
  ]);
  const docByItem = new Map();
  const extraDocs = [];
  for (const d of docs) {
    if (Number.isInteger(d.batchItem) && d.batchItem < batch.items.length) docByItem.set(d.batchItem, d);
    else extraDocs.push(d);
  }
  const sessionByItem = new Map();
  for (const s of sessions) {
    const i = s.hints && s.hints.batchItem;
    if (Number.isInteger(i)) sessionByItem.set(i, s); // latest wins (sorted ascending)
  }

  const rows = batch.items.map((it, index) => {
    const doc = docByItem.get(index);
    const sess = sessionByItem.get(index);
    let state = 'not_uploaded';
    if (it.cancelled && !doc) state = 'cancelled';
    else if (doc) state = doc.status;
    else if (sess && sess.status === 'pending') state = 'uploading';
    else if (sess && sess.status === 'failed') state = 'upload_failed';
    return {
      index,
      name: it.name,
      size: it.size,
      path: it.path,
      state,
      stage: doc ? doc.stage : null,
      error: (doc && doc.error) || (sess && sess.status === 'failed' ? sess.error : '') || '',
      documentId: doc ? String(doc._id) : null,
      uploadedAt: doc ? doc.createdAt : null,
    };
  });
  for (const d of extraDocs) {
    rows.push({
      index: null,
      name: d.fileName,
      size: d.sizeBytes || 0,
      path: '',
      state: d.status,
      stage: d.stage,
      error: d.error || '',
      documentId: String(d._id),
      uploadedAt: d.createdAt,
    });
  }
  return rows;
}

function countRows(rows) {
  const c = {
    total: 0,
    uploaded: 0,
    uploading: 0,
    processing: 0,
    ready: 0,
    needsReview: 0,
    failed: 0,
    uploadFailed: 0,
    notUploaded: 0,
    cancelled: 0,
  };
  for (const r of rows) {
    if (r.state === 'cancelled') {
      c.cancelled++;
      continue;
    }
    c.total++;
    if (r.documentId) c.uploaded++;
    if (r.state === 'processing') c.processing++;
    else if (r.state === 'ready') c.ready++;
    else if (r.state === 'needs_review') c.needsReview++;
    else if (r.state === 'failed') c.failed++;
    else if (r.state === 'upload_failed') c.uploadFailed++;
    else if (r.state === 'uploading') c.uploading++;
    else if (r.state === 'not_uploaded') c.notUploaded++;
  }
  return c;
}

/** Recompute counts and status; emits batch.completed once when everything is final. */
async function refreshBatch(batchId) {
  if (!isId(batchId)) return null;
  const batch = await Batch.findById(batchId);
  if (!batch) return null;
  const rows = await itemStates(batch);
  const counts = countRows(rows);
  const allFinal = rows.every((r) => FINAL_ITEM_STATES.has(r.state));
  if (batch.closedAt && allFinal) {
    const done = await Batch.findOneAndUpdate(
      { _id: batch._id, status: { $ne: 'completed' } },
      { status: 'completed', completedAt: new Date(), counts },
      { new: true }
    );
    if (done) {
      await emitAudit({ userId: done.createdBy, action: 'batch.completed', details: { batchId: String(done._id), counts } });
      return done;
    }
    return Batch.findByIdAndUpdate(batch._id, { counts }, { new: true });
  }
  return Batch.findByIdAndUpdate(
    batch._id,
    { counts, status: batch.closedAt ? 'processing' : 'open', completedAt: null },
    { new: true }
  );
}

events.on('batch.touch', refreshBatch);

function summary(batch) {
  const b = batch.toObject ? batch.toObject() : batch;
  const { items, ...rest } = b;
  return { ...rest, itemCount: (items || []).length };
}

async function listBatches(userId) {
  if (!isId(userId)) throw new BatchError(400, 'A valid userId is required');
  const batches = await Batch.find({ createdBy: userId }).sort({ createdAt: -1 }).limit(200);
  return batches.map(summary);
}

async function getBatch(batchId, userId) {
  const batch = await loadOwned(batchId, userId);
  const rows = await itemStates(batch);
  return { batch: { ...summary(batch), counts: countRows(rows) }, items: rows };
}

/** All files have been handed to the uploader; the batch can complete once work ends. */
async function closeBatch(batchId, userId) {
  const batch = await loadOwned(batchId, userId);
  if (!batch.closedAt) await Batch.updateOne({ _id: batch._id }, { closedAt: new Date() });
  return summary(await refreshBatch(batch._id));
}

async function retryFailed(batchId, userId) {
  const batch = await loadOwned(batchId, userId);
  const failed = await File.find({ batchId: batch._id, status: 'failed' }).select('_id');
  for (const f of failed) {
    await File.updateOne({ _id: f._id, status: 'failed' }, { status: 'processing', error: '', errorCode: '', attempts: 0 });
    enqueueDocument(f._id);
  }
  await emitAudit({ userId, action: 'batch.retry_failed', details: { batchId: String(batch._id), documents: failed.length } });
  await refreshBatch(batch._id);
  return { retried: failed.length };
}

/** Cancel files that never finished uploading (all, or the given item indexes). */
async function cancelUnfinished(batchId, userId, indexes) {
  const batch = await loadOwned(batchId, userId);
  const rows = await itemStates(batch);
  const wanted = Array.isArray(indexes) ? new Set(indexes.map(Number)) : null;
  const targets = rows.filter(
    (r) =>
      r.index !== null &&
      ['not_uploaded', 'uploading', 'upload_failed'].includes(r.state) &&
      (!wanted || wanted.has(r.index))
  );
  if (targets.length) {
    const pending = await UploadSession.find({ batchId: batch._id, status: 'pending' }).select('_id hints');
    for (const s of pending) {
      if (targets.some((t) => t.index === (s.hints && s.hints.batchItem)))
        await abortSession(s._id, { userId, reason: 'cancelled from batch' });
    }
    const set = {};
    targets.forEach((t) => {
      set[`items.${t.index}.cancelled`] = true;
    });
    await Batch.updateOne({ _id: batch._id }, { $set: set });
    await emitAudit({
      userId,
      action: 'batch.items_cancelled',
      details: { batchId: String(batch._id), files: targets.map((t) => t.name) },
    });
  }
  await refreshBatch(batch._id);
  return { cancelled: targets.length };
}

// Spreadsheet-safe CSV cell: quote, escape, and neutralise formula injection.
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

const STATE_LABELS = {
  not_uploaded: 'Not uploaded',
  uploading: 'Uploading',
  upload_failed: 'Upload failed',
  processing: 'Processing',
  ready: 'Ready',
  needs_review: 'Needs review',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

async function reportCsv(batchId, userId) {
  const { batch, items } = await getBatch(batchId, userId);
  const header = ['#', 'File name', 'Folder path', 'Size (bytes)', 'Status', 'Step', 'Error', 'Document ID', 'Uploaded at'];
  const lines = [header.map(cell).join(',')];
  for (const r of items) {
    lines.push(
      [
        r.index === null ? '' : r.index + 1,
        r.name,
        r.path,
        r.size,
        STATE_LABELS[r.state] || r.state,
        r.stage || '',
        r.error,
        r.documentId || '',
        r.uploadedAt ? new Date(r.uploadedAt).toISOString() : '',
      ]
        .map(cell)
        .join(',')
    );
  }
  const c = batch.counts;
  lines.push('');
  lines.push(
    [
      'Totals',
      `files ${c.total}`,
      `ready ${c.ready}`,
      `needs review ${c.needsReview}`,
      `failed ${c.failed + c.uploadFailed}`,
      `not uploaded ${c.notUploaded + c.uploading}`,
      `cancelled ${c.cancelled}`,
    ]
      .map(cell)
      .join(',')
  );
  const safeName =
    batch.name
      .replace(/[^\w\- ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'batch';
  return { filename: `${safeName}.csv`, csv: `﻿${lines.join('\r\n')}\r\n` };
}

module.exports = {
  BatchError,
  createBatch,
  listBatches,
  getBatch,
  closeBatch,
  retryFailed,
  cancelUnfinished,
  reportCsv,
  refreshBatch,
};
