// Upload sessions: validate → hand the browser an upload target (presigned S3 URL,
// multipart part URLs, or the server proxy) → on "complete", verify what landed in
// storage and turn it into a File that enters the intake pipeline.
const crypto = require('crypto');
const { Transform } = require('stream');
const mongoose = require('mongoose');
const config = require('../../core/config');
const { emitAudit } = require('../../core/audit');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const Folder = require('../../models/Folder');
const Batch = require('../../models/Batch');
const events = require('../../core/events');
const User = require('../../models/User');
const UploadSession = require('./UploadSession.model');
const { typeForName, contentMatches, publicTypes } = require('./fileTypes');
const { enqueueDocument } = require('../intake/pipeline');

class UploadError extends Error {
  constructor(status, message, code = 'UPLOAD_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MB = 1024 * 1024;
const fmtMB = (b) => `${Math.round((b / MB) * 10) / 10} MB`;
const isId = (v) => !!v && mongoose.isValidObjectId(v);
const touchBatch = (batchId) => batchId && events.emit('batch.touch', String(batchId));
const safeKeyName = (name) => String(name).replace(/[^\w.\- ]+/g, '_').slice(-150);

function uploadConfig() {
  const u = config.upload;
  const types = publicTypes();
  return {
    maxBytes: u.maxBytes,
    multipartThresholdBytes: u.multipartThresholdBytes,
    partSizeBytes: u.partSizeBytes,
    transport: u.transport,
    acceptedTypes: types,
    accept: types.map((t) => `.${t.ext}`).join(','),
  };
}

function pickTransport(requested) {
  const forced = config.upload.transport;
  if (forced === 'direct' || forced === 'proxy') return forced;
  return requested === 'proxy' ? 'proxy' : 'direct';
}

async function loadOwnedSession(sessionId, userId) {
  if (!isId(sessionId)) throw new UploadError(404, 'Upload not found', 'NOT_FOUND');
  const s = await UploadSession.findById(sessionId);
  if (!s) throw new UploadError(404, 'Upload not found', 'NOT_FOUND');
  if (!userId || String(s.userId) !== String(userId))
    throw new UploadError(403, 'This upload belongs to another user', 'FORBIDDEN');
  return s;
}

/** Step 1: validate the file and return where the browser should send the bytes. */
async function createSession({ userId, fileName, sizeBytes, folderId, batchId, batchItem, hints, transport }) {
  if (!isId(userId) || !(await User.exists({ _id: userId })))
    throw new UploadError(400, 'A valid userId is required', 'BAD_USER');
  const name = String(fileName || '').trim();
  if (!name) throw new UploadError(400, 'fileName is required', 'BAD_NAME');

  const type = typeForName(name);
  if (!type) {
    const list = publicTypes().map((t) => `.${t.ext}`).join(', ');
    throw new UploadError(415, `"${name}" is not a supported file type. Accepted: ${list}`, 'UNSUPPORTED_TYPE');
  }
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) throw new UploadError(400, `"${name}" is empty`, 'EMPTY_FILE');
  if (size > config.upload.maxBytes)
    throw new UploadError(413, `"${name}" is ${fmtMB(size)}; the limit is ${fmtMB(config.upload.maxBytes)}`, 'TOO_LARGE');

  if (folderId) {
    if (!isId(folderId)) throw new UploadError(400, 'Invalid folderId', 'BAD_FOLDER');
    const folder = await Folder.findById(folderId).select('userId').lean();
    if (!folder || String(folder.userId) !== String(userId))
      throw new UploadError(404, 'Folder not found', 'BAD_FOLDER');
  }

  let item = null;
  if (batchId) {
    if (!isId(batchId)) throw new UploadError(400, 'Invalid batchId', 'BAD_BATCH');
    const batch = await Batch.findById(batchId).select('createdBy items').lean();
    if (!batch || String(batch.createdBy) !== String(userId)) throw new UploadError(404, 'Batch not found', 'BAD_BATCH');
    if (batchItem !== undefined && batchItem !== null) {
      item = Number(batchItem);
      if (!Number.isInteger(item) || item < 0 || item >= batch.items.length)
        throw new UploadError(400, 'Invalid batch item', 'BAD_BATCH_ITEM');
      if (batch.items[item].cancelled) throw new UploadError(409, 'This file was cancelled from the batch', 'ITEM_CANCELLED');
    }
  }

  const chosen = pickTransport(transport);
  const rand = crypto.randomBytes(4).toString('hex');
  const s3Key = `${userId}/${folderId ? `${folderId}/` : ''}${Date.now()}-${rand}-${safeKeyName(name)}`;
  const expiresAt = new Date(Date.now() + config.upload.sessionTtlHours * 3600 * 1000);
  const expSec = config.upload.presignExpiresSec;

  const session = new UploadSession({
    userId,
    fileName: name,
    ext: type.ext,
    mimeType: type.mime,
    sizeBytes: size,
    s3Key,
    transport: chosen,
    folderId: folderId || null,
    batchId: batchId || null,
    hints: { ...(hints && typeof hints === 'object' ? hints : {}), ...(item !== null ? { batchItem: item } : {}) },
    expiresAt,
  });

  const target = { uploadId: String(session._id), transport: chosen, contentType: type.mime };
  if (chosen === 'proxy') {
    target.proxyUrl = `/api/uploads/${session._id}/content`;
  } else if (size > config.upload.multipartThresholdBytes) {
    const partSize = config.upload.partSizeBytes;
    const partCount = Math.ceil(size / partSize);
    session.s3UploadId = await storage.createMultipart(s3Key, type.mime);
    session.partSizeBytes = partSize;
    session.partCount = partCount;
    target.multipart = {
      partSizeBytes: partSize,
      parts: Array.from({ length: partCount }, (_, i) => ({
        partNumber: i + 1,
        url: storage.presignPart(s3Key, session.s3UploadId, i + 1, expSec),
      })),
    };
  } else {
    target.url = storage.presignPut(s3Key, type.mime, expSec);
  }

  await session.save();
  await emitAudit({
    userId,
    action: 'upload.started',
    details: { uploadId: target.uploadId, fileName: name, sizeBytes: size, transport: chosen, multipart: !!target.multipart },
  });
  return target;
}

/** Proxy transport: stream the request body to S3, never more than the declared size. */
async function receiveProxyContent(sessionId, userId, req) {
  const s = await loadOwnedSession(sessionId, userId);
  if (s.status !== 'pending') throw new UploadError(409, 'This upload is already finished', 'NOT_PENDING');
  if (s.transport !== 'proxy') throw new UploadError(400, 'This upload must be sent directly to storage', 'WRONG_TRANSPORT');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > s.sizeBytes)
    throw new UploadError(413, 'The file is larger than announced', 'SIZE_MISMATCH');

  let received = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (received > s.sizeBytes) cb(new UploadError(413, 'The file is larger than announced', 'SIZE_MISMATCH'));
      else cb(null, chunk);
    },
  });
  req.on('error', (e) => limiter.destroy(e));
  req.pipe(limiter);
  await storage.putStream(s.s3Key, limiter, s.mimeType);
  return { received };
}

async function failSession(s, message, code) {
  s.status = 'failed';
  s.error = message;
  s.expiresAt = null;
  await s.save();
  await storage.deleteObject(s.s3Key).catch(() => {});
  await emitAudit({
    userId: s.userId,
    action: 'upload.failed',
    details: { uploadId: String(s._id), fileName: s.fileName, code, error: message },
  });
  touchBatch(s.batchId);
  return new UploadError(422, message, code);
}

/** Step 2: verify what is in storage and create the document. */
async function completeSession(sessionId, { userId, parts }) {
  const s = await loadOwnedSession(sessionId, userId);
  if (s.status === 'completed' && s.fileId) {
    return File.findById(s.fileId).select('-rawText -tablesCsv -words'); // idempotent
  }
  if (s.status !== 'pending') throw new UploadError(409, 'This upload is already finished', 'NOT_PENDING');

  if (s.s3UploadId) {
    const list = Array.isArray(parts) ? parts : [];
    const numbers = new Set(list.map((p) => Number(p.PartNumber)));
    if (list.length !== s.partCount || numbers.size !== s.partCount || list.some((p) => !p.ETag))
      throw new UploadError(400, `Expected ${s.partCount} uploaded parts`, 'MISSING_PARTS');
    try {
      await storage.completeMultipart(s.s3Key, s.s3UploadId, list);
    } catch (e) {
      throw await failSession(s, 'Storage could not assemble the uploaded parts. Please upload again.', 'MULTIPART_FAILED');
    }
  }

  const head = await storage.headObject(s.s3Key);
  if (!head) throw await failSession(s, 'The file did not reach storage. Please upload it again.', 'NOT_IN_STORAGE');
  if (head.size !== s.sizeBytes)
    throw await failSession(
      s,
      `The stored file is ${fmtMB(head.size)} but ${fmtMB(s.sizeBytes)} was expected. Please upload it again.`,
      'SIZE_MISMATCH'
    );

  const type = typeForName(s.fileName);
  const headBytes = await storage.readHead(s.s3Key);
  if (!contentMatches(type, headBytes))
    throw await failSession(
      s,
      `"${s.fileName}" does not contain ${type.label} data. It may be renamed or damaged.`,
      'CONTENT_MISMATCH'
    );

  const hints = s.hints || {};
  const file = await File.create({
    userId: s.userId,
    folderId: s.folderId,
    batchId: s.batchId,
    batchItem: Number.isInteger(hints.batchItem) ? hints.batchItem : null,
    fileName: s.fileName,
    s3Key: s.s3Key,
    mimeType: s.mimeType,
    sizeBytes: s.sizeBytes,
    source: 'upload',
    status: 'processing',
    metadata: {
      ...(hints.documentType ? { documentType: String(hints.documentType) } : {}),
      ...(hints.personId ? { personId: String(hints.personId) } : {}),
    },
  });

  s.status = 'completed';
  s.fileId = file._id;
  s.expiresAt = null;
  await s.save();

  await emitAudit({
    userId: s.userId,
    action: 'upload.completed',
    documentId: file._id,
    details: { uploadId: String(s._id), fileName: s.fileName, sizeBytes: s.sizeBytes, transport: s.transport },
  });
  enqueueDocument(file._id);
  touchBatch(s.batchId);
  return File.findById(file._id).select('-rawText -tablesCsv -words');
}

/** Cancel an unfinished upload (user cancelled, or the browser gave up). */
async function abortSession(sessionId, { userId, reason }) {
  const s = await loadOwnedSession(sessionId, userId);
  if (s.status !== 'pending') return { status: s.status };
  if (s.s3UploadId) await storage.abortMultipart(s.s3Key, s.s3UploadId).catch(() => {});
  await storage.deleteObject(s.s3Key).catch(() => {});
  s.status = 'aborted';
  s.error = String(reason || 'cancelled').slice(0, 300);
  s.expiresAt = null;
  await s.save();
  await emitAudit({
    userId: s.userId,
    action: 'upload.failed',
    details: { uploadId: String(s._id), fileName: s.fileName, code: 'ABORTED', error: s.error },
  });
  touchBatch(s.batchId);
  return { status: 'aborted' };
}

module.exports = { UploadError, uploadConfig, createSession, receiveProxyContent, completeSession, abortSession };
