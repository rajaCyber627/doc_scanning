// Create child documents from a container (email attachments, files in a ZIP).
// Each child is checked like an upload (type, real content, size); programs and
// scripts are never imported. Re-running is safe: children are keyed by position.
const path = require('path');
const crypto = require('crypto');
const config = require('../../core/config');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const AttachmentClaim = require('../emailintake/AttachmentClaim.model');
const { typeForName, contentMatches, mismatchReason, isExecutableName } = require('../upload/fileTypes');

const safeKeyName = (name) => String(name).replace(/[^\w.\- ]+/g, '_').slice(-150);
const cleanName = (name) =>
  path.posix.basename(String(name || '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 255);

/**
 * @param parent   the container File document
 * @param children [{ fileName, buffer, path? }]
 * @param preSkipped [{ name, reason }] already rejected by the parser
 * @returns {{ created: number, skipped: Array<{name, reason}> }}
 */
async function createChildren(parent, children, preSkipped = []) {
  const depth = (parent.containerDepth || 0) + 1;
  const max = config.formats.maxChildren;
  const skipped = [...preSkipped];
  let created = 0;

  for (const [i, ch] of children.slice(0, max).entries()) {
    const name = cleanName(ch.fileName) || `attachment-${i + 1}`;
    const buf = ch.buffer || Buffer.alloc(0);
    const type = typeForName(name);
    let reason = null;
    if (isExecutableName(name)) reason = 'Programs and scripts are never imported';
    else if (!type) reason = 'Unsupported file type';
    else if (!buf.length) reason = 'Empty file';
    else if (buf.length > config.upload.maxBytes) reason = 'Larger than the upload limit';
    else if (!contentMatches(type, buf.subarray(0, 4096))) reason = mismatchReason(type, buf.subarray(0, 4096), name);
    else if (type.container && depth >= config.formats.maxContainerDepth)
      reason = 'Archives or emails nested this deep are not expanded';
    if (reason) {
      skipped.push({ name, reason });
      continue;
    }

    // e-mailed files (P15): a forwarded copy of a file already in the system is not stored again
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    const dedupe = parent.source === 'email';
    if (dedupe) {
      const same = await File.findOne({ sha256: digest, supersededBy: null, parentDocumentId: { $ne: parent._id } }).select('fileName').lean();
      if (same) {
        skipped.push({ name, reason: `Already captured — same file as "${same.fileName}"` });
        continue;
      }
      // two emails carrying the same file processed at once: only one may claim it
      try {
        await AttachmentClaim.init(); // the unique index must exist before it can decide
        await AttachmentClaim.create({ sha256: digest });
      } catch (e) {
        if (e && e.code === 11000 && !(await File.exists({ parentDocumentId: parent._id, sha256: digest }))) {
          skipped.push({ name, reason: 'Already captured — the same file arrived in another email at the same time' });
          continue;
        }
        if (!e || e.code !== 11000) throw e;
      }
    }
    const key = `${parent.s3Key}.parts/${String(i).padStart(3, '0')}-${safeKeyName(name)}`;
    if (await File.exists({ parentDocumentId: parent._id, s3Key: key })) {
      created++;
      continue;
    }
    await storage.putStream(key, buf, type.mime);
    const child = await File.create({
      userId: parent.userId,
      folderId: parent.folderId,
      batchId: parent.batchId,
      fileName: name,
      s3Key: key,
      mimeType: type.mime,
      sizeBytes: buf.length,
      source: parent.source,
      status: 'processing',
      parentDocumentId: parent._id,
      containerDepth: depth,
      metadata: {
        ...(ch.path && ch.path !== name ? { sourcePath: ch.path } : {}),
        // email subject / body hints travel with each attachment (classification context)
        ...(parent.metadata && parent.metadata.intakeHints ? { intakeHints: parent.metadata.intakeHints } : {}),
      },
      ...(parent.confidentiality === 'restricted' ? { confidentiality: 'restricted' } : {}),
      sha256: digest,
    });
    created++;
    await emitAudit({
      userId: parent.userId,
      action: 'document.extracted',
      documentId: child._id,
      details: { parentDocumentId: String(parent._id), fileName: name },
    });
    // Lazy require: the intake pipeline loads this module itself.
    require('../intake/pipeline').enqueueDocument(child._id);
  }
  if (children.length > max) skipped.push({ name: `${children.length - max} more files`, reason: `Only the first ${max} are imported` });
  if (parent.batchId) events.emit('batch.touch', String(parent.batchId));
  return { created, skipped };
}

module.exports = { createChildren };
