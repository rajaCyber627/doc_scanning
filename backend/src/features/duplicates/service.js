// Duplicate detection and decisions.
//  checkDuplicates(file)  — run by the "dedupe" pipeline stage: exact file (SHA-256) in
//                           the hub or the partner system, same text, near-same text.
//                           The earlier document counts as the original, so two copies
//                           in one batch don't flag each other.
//  decide(fileId, …)      — Keep both | Replace existing (new version; never deletes) |
//                           Discard new. Every decision is audited with its reason.
const mongoose = require('mongoose');
const config = require('../../core/config');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { viewerFor, isRestricted } = require('../../core/access');
const { getPartner } = require('../../providers/partner');
const File = require('../../models/File');
const User = require('../../models/User');
const { fingerprint, similarity, setSimilarity } = require('./fingerprint');

class DuplicateError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const STAGE = 'duplicates';
const LIVE = ['processing', 'ready', 'needs_review'];
const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

function isEarlier(other, file) {
  const a = +new Date(other.createdAt);
  const b = +new Date(file.createdAt);
  return a < b || (a === b && String(other._id) < String(file._id));
}

function reasonFor(match, file, canSeeRestricted) {
  const hidden = match.restricted && !canSeeRestricted;
  if (match.where === 'partner') {
    return {
      code: 'DUPLICATE_PARTNER',
      message: hidden ? 'A restricted record with the same file already exists in the HR records system' : 'This exact file is already in the HR records system',
    };
  }
  const where = match.sameBatch ? ' in this batch' : '';
  if (hidden) {
    return {
      code: match.kind === 'exact' ? 'DUPLICATE_EXACT' : 'DUPLICATE_CONTENT',
      message: `A restricted record with the same ${match.kind === 'exact' ? 'file' : 'content'} already exists`,
    };
  }
  if (match.kind === 'exact') {
    return { code: 'DUPLICATE_EXACT', message: `Same file as "${match.fileName}" uploaded ${fmtDate(match.createdAt)}${where}` };
  }
  return {
    code: 'DUPLICATE_CONTENT',
    message: `Same content as "${match.fileName}" (${Math.round(match.similarity * 100)}% similar), uploaded ${fmtDate(match.createdAt)}${where}`,
  };
}

/** Fingerprint + matches for a processed document. Returns fields to save. */
async function checkDuplicates(file) {
  const fp = fingerprint(file.rawText);
  // a split original and the file a part was cut from are never "duplicates" of it
  const base = { _id: { $nin: [file._id, ...(file.derivedFrom || [])] }, status: { $in: LIVE }, supersededBy: null, 'splitInto.0': { $exists: false } };
  const fields = '_id fileName createdAt userId batchId confidentiality minhash numberTokens handoff';
  const found = new Map(); // fileId → match (exact beats content)
  const add = (o, kind, sim) => {
    if (!isEarlier(o, file)) return;
    const prev = found.get(String(o._id));
    if (prev && (prev.kind === 'exact' || prev.similarity >= sim)) return;
    found.set(String(o._id), {
      kind,
      where: 'hub',
      fileId: o._id,
      fileName: o.fileName,
      createdAt: o.createdAt,
      similarity: Math.round(sim * 100) / 100,
      sameBatch: !!(file.batchId && o.batchId && String(file.batchId) === String(o.batchId)),
      restricted: isRestricted(o.confidentiality),
      partnerDocumentId: (o.handoff && o.handoff.partnerDocumentId) || null,
    });
  };

  if (file.sha256) for (const o of await File.find({ ...base, sha256: file.sha256 }).select(fields).lean()) add(o, 'exact', 1);
  if (fp) {
    for (const o of await File.find({ ...base, contentHash: fp.contentHash }).select(fields).lean()) add(o, 'content', 1);
    const candidates = await File.find({ ...base, lshBands: { $in: fp.lshBands } }).select(fields).limit(200).lean();
    for (const o of candidates) {
      const sim = similarity(fp.minhash, o.minhash);
      const numbersAgree = setSimilarity(fp.numbers, o.numberTokens) >= config.duplicates.numberAgreement;
      if (sim >= config.duplicates.contentSimilarity && numbersAgree) add(o, 'content', sim);
    }
  }
  const matches = [...found.values()].sort((a, b) => (a.kind === b.kind ? b.similarity - a.similarity : a.kind === 'exact' ? -1 : 1));

  // The partner system of record — unless that copy is one of the hub matches above.
  if (file.sha256) {
    const p = await getPartner().findByHash(file.sha256).catch(() => null);
    const own = file.handoff && file.handoff.partnerDocumentId;
    if (p && p.partnerDocumentId !== own && !matches.some((m) => m.partnerDocumentId === p.partnerDocumentId)) {
      matches.push({ kind: 'exact', where: 'partner', partnerDocumentId: p.partnerDocumentId, similarity: 1, restricted: !!p.restricted });
    }
  }

  const viewer = await viewerFor(file.userId);
  const reasons = matches.slice(0, 5).map((m) => ({ ...reasonFor(m, file, viewer && viewer.canSeeRestricted), stage: STAGE }));
  return {
    contentHash: fp ? fp.contentHash : null,
    minhash: fp ? fp.minhash : [],
    lshBands: fp ? fp.lshBands : [],
    numberTokens: fp ? fp.numbers : [],
    duplicateOf: matches.map(({ fileName, createdAt, ...m }) => m), // names/dates are looked up fresh when shown
    reviewReasons: [...(file.reviewReasons || []).filter((r) => r.stage !== STAGE), ...reasons],
  };
}

/** Matches for the compare view, with restricted details hidden from viewers without permission. */
async function describeMatches(fileId, userId) {
  if (!mongoose.isValidObjectId(fileId)) throw new DuplicateError(404, 'File not found');
  const file = await File.findById(fileId).select('fileName createdAt sizeBytes summary duplicateOf status reviewReasons userId').lean();
  if (!file) throw new DuplicateError(404, 'File not found');
  const viewer = await viewerFor(userId);
  const canSee = !!(viewer && viewer.canSeeRestricted);
  const ids = (file.duplicateOf || []).filter((m) => m.fileId).map((m) => m.fileId);
  const others = await File.find({ _id: { $in: ids } })
    .select('fileName createdAt sizeBytes summary status userId folderId supersededBy')
    .lean();
  const byId = new Map(others.map((o) => [String(o._id), o]));
  const users = await User.find({ _id: { $in: others.map((o) => o.userId) } }).select('firstName lastName userName').lean();
  const nameOf = new Map(users.map((u) => [String(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ') || u.userName]));
  const matches = (file.duplicateOf || []).map((m) => {
    const base = { kind: m.kind, where: m.where, similarity: m.similarity, sameBatch: !!m.sameBatch };
    if (m.restricted && !canSee) return { ...base, restricted: true };
    if (m.where === 'partner') return { ...base, restricted: !!m.restricted, partnerDocumentId: m.partnerDocumentId };
    const o = byId.get(String(m.fileId));
    if (!o) return { ...base, removed: true };
    return {
      ...base,
      restricted: !!m.restricted,
      fileId: String(o._id),
      fileName: o.fileName,
      uploadedAt: o.createdAt,
      uploadedBy: nameOf.get(String(o.userId)) || 'another user',
      status: o.status,
      superseded: !!o.supersededBy,
      sizeBytes: o.sizeBytes,
      summary: o.summary,
    };
  });
  return {
    document: { fileId: String(file._id), fileName: file.fileName, uploadedAt: file.createdAt, sizeBytes: file.sizeBytes, summary: file.summary, status: file.status },
    open: (file.reviewReasons || []).some((r) => r.stage === STAGE),
    matches,
  };
}

const ACTIONS = ['keep_both', 'replace', 'discard'];

async function decide(fileId, { userId, action, reason }) {
  if (!ACTIONS.includes(action)) throw new DuplicateError(400, `action must be one of ${ACTIONS.join(', ')}`);
  if (!mongoose.isValidObjectId(fileId)) throw new DuplicateError(404, 'File not found');
  const file = await File.findById(fileId);
  if (!file) throw new DuplicateError(404, 'File not found');
  const open = (file.reviewReasons || []).filter((r) => r.stage === STAGE);
  if (!open.length) throw new DuplicateError(409, 'This document is not flagged as a duplicate');
  const actor = mongoose.isValidObjectId(userId) ? userId : null;
  const why = String(reason || '').slice(0, 500);
  const details = { action, reason: why, matches: (file.duplicateOf || []).map((m) => ({ kind: m.kind, where: m.where, fileId: m.fileId ? String(m.fileId) : null })) };

  if (action === 'discard') {
    await emitAudit({ userId: actor || file.userId, action: 'duplicate.discarded', documentId: file._id, details: { ...details, fileName: file.fileName } });
    await require('../documents/removeDocument').removeDocument(file);
    return { action, deleted: true };
  }

  let replaced = null;
  if (action === 'replace') {
    const viewer = await viewerFor(actor || file.userId);
    const target = (file.duplicateOf || []).find((m) => m.where === 'hub' && m.fileId && (!m.restricted || (viewer && viewer.canSeeRestricted)));
    if (!target) throw new DuplicateError(400, 'There is no earlier document here that you can replace');
    replaced = await File.findOneAndUpdate(
      { _id: target.fileId, supersededBy: null },
      { supersededBy: file._id, supersededAt: new Date() },
      { new: true }
    );
    if (!replaced) throw new DuplicateError(409, 'The earlier document was already replaced or removed');
    file.supersedes = replaced._id;
    details.replacedFileId = String(replaced._id);
  }

  const remaining = file.reviewReasons.filter((r) => r.stage !== STAGE);
  file.resolvedReviewReasons.push(...open.map((r) => ({ ...r, resolvedAt: new Date(), resolvedBy: actor, decision: action })));
  file.reviewReasons = remaining;
  file.duplicateDecision = { action, reason: why, by: actor, at: new Date() };
  if (file.status === 'needs_review' && !remaining.length) file.status = 'ready';
  await file.save();

  await emitAudit({ userId: actor || file.userId, action: action === 'replace' ? 'duplicate.replaced' : 'duplicate.kept_both', documentId: file._id, details });
  if (replaced) {
    await emitAudit({ userId: actor || file.userId, action: 'document.superseded', documentId: replaced._id, details: { supersededBy: String(file._id) } });
    events.emit('document.changed', String(replaced._id));
  }
  events.emit('document.changed', String(file._id));
  if (file.batchId) events.emit('batch.touch', String(file.batchId));
  return { action, file: { _id: String(file._id), status: file.status }, replacedFileId: replaced ? String(replaced._id) : null };
}

/** Apply one decision to every open duplicate in a batch. */
async function decideBatch(batchId, { userId, action, reason }) {
  const Batch = require('../../models/Batch');
  if (!mongoose.isValidObjectId(batchId)) throw new DuplicateError(404, 'Batch not found');
  const batch = await Batch.findById(batchId).select('createdBy');
  if (!batch || String(batch.createdBy) !== String(userId)) throw new DuplicateError(404, 'Batch not found');
  const docs = await File.find({ batchId, 'reviewReasons.stage': STAGE }).select('_id');
  let done = 0;
  const errors = [];
  for (const d of docs) {
    try {
      await decide(d._id, { userId, action, reason });
      done++;
    } catch (e) {
      errors.push({ fileId: String(d._id), message: e.message });
    }
  }
  return { decided: done, errors };
}

module.exports = { checkDuplicates, describeMatches, decide, decideBatch, DuplicateError, STAGE };
