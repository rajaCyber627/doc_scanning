// Scan batches (P14): a stack of paper scanned in one run — tracked from the pages that
// arrive (camera, scanner folder, upload) to the documents they become, with a quality-
// control sample and a reconciliation report (pages in = pages in documents + pages
// removed), which is also the evidence used in the paper-conversion method (P17).
const crypto = require('crypto');
const mongoose = require('mongoose');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { viewerFor, isRestricted } = require('../../core/access');
const File = require('../../models/File');
const User = require('../../models/User');
const Batch = require('../../models/Batch');
const Setting = require('../../models/Setting');
const metadata = require('../metadata/service');
const { textToPdf } = require('../documents/formats/pdfBuilder');
const { BatchError } = require('./service');

const isId = (v) => mongoose.isValidObjectId(v);
const SPLIT_MODES = ['separators', 'suggest', 'auto'];

async function loadScanBatch(batchId, userId) {
  if (!isId(batchId) || !isId(userId)) throw new BatchError(404, 'Batch not found');
  const batch = await Batch.findById(batchId);
  if (!batch || String(batch.createdBy) !== String(userId)) throw new BatchError(404, 'Batch not found');
  if (batch.kind !== 'scan') throw new BatchError(409, 'This is not a scan batch');
  return batch;
}

// ---------------------------------------------------------------- start
async function createScanBatch({ userId, name, boxId, expectedPages, splitMode, folderId } = {}) {
  if (!isId(userId) || !(await User.exists({ _id: userId }))) throw new BatchError(400, 'A valid userId is required');
  const box = String(boxId || '').trim().slice(0, 80);
  if (box && !/^[\w .\-/#]+$/.test(box)) throw new BatchError(400, 'The box / folder ID may only contain letters, digits, spaces and - _ . / #');
  let expected = null;
  if (expectedPages !== undefined && expectedPages !== null && expectedPages !== '') {
    expected = Number(expectedPages);
    if (!Number.isInteger(expected) || expected < 1 || expected > 1000000) throw new BatchError(400, 'Expected pages must be a whole number');
  }
  const when = new Date().toISOString().slice(0, 10);
  const batch = await Batch.create({
    name: String(name || '').trim().slice(0, 200) || `Scan · ${box || when}`,
    source: 'scanner',
    kind: 'scan',
    createdBy: userId,
    folderId: isId(folderId) ? folderId : null,
    boxId: box,
    expectedPages: expected,
    splitMode: SPLIT_MODES.includes(splitMode) ? splitMode : 'suggest',
    items: [],
  });
  await emitAudit({
    userId,
    action: 'batch.started',
    details: { batchId: String(batch._id), name: batch.name, kind: 'scan', boxId: box, expectedPages: expected, splitMode: batch.splitMode },
  });
  return batch.toObject();
}

/** Hot folders: the open scan batch whose box ID matches a scanner sub-folder. */
async function openScanBatchForBox(ownerId, boxId) {
  if (!boxId) return null;
  const esc = String(boxId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Batch.findOne({ createdBy: ownerId, kind: 'scan', boxId: new RegExp(`^${esc}$`, 'i'), status: { $ne: 'completed' }, closedAt: null }).sort({ createdAt: -1 });
}

// ---------------------------------------------------------------- dashboard
const FIELDS = 'fileName status stage metadataStatus pageCount splitInto splitFrom splitRemoved confidentiality duplicateOf duplicateDecision reviewReasons metadata classification rescan error createdAt';
const isSplitOriginal = (f) => (f.splitInto || []).length > 0;
const openStage = (f, stage) => (f.reviewReasons || []).some((r) => r.stage === stage);

function categorize(f) {
  const tags = [];
  if (f.status === 'processing') tags.push('processing');
  if (f.status === 'failed') tags.push('failed');
  if (f.status === 'ready') tags.push('ready');
  if (f.status === 'needs_review') tags.push('needs_review');
  if (isRestricted(f.confidentiality)) tags.push('restricted');
  if (openStage(f, 'duplicates')) tags.push('duplicate');
  if (openStage(f, 'splitting')) tags.push('split_suggested');
  if (f.rescan) tags.push('rescan');
  return tags;
}

async function summarize(batch) {
  const files = await File.find({ batchId: batch._id }).select(FIELDS).sort({ createdAt: 1 }).lean();
  const tax = await metadata.getTaxonomy();
  const typeName = (k) => (tax.documentTypes.find((t) => t.key === k) || {}).name || k;
  const received = files.filter((f) => !f.splitFrom); // what arrived (parts are derived)
  const documents = files.filter((f) => !isSplitOriginal(f)); // what it became
  const pending = files.some((f) => f.status === 'processing');
  const pages = {
    expected: batch.expectedPages || null,
    received: received.reduce((a, f) => a + (f.pageCount || 0), 0),
    inDocuments: documents.reduce((a, f) => a + (f.pageCount || 0), 0),
    removed: files.reduce((a, f) => a + (f.splitRemoved || []).length, 0),
    unknown: received.filter((f) => !f.pageCount).length, // still processing / failed before counting
  };
  pages.missing = pending ? null : pages.received - pages.inDocuments - pages.removed;
  const counts = { received: received.length, documents: documents.length, processing: 0, ready: 0, needs_review: 0, failed: 0, restricted: 0, duplicate: 0, split_suggested: 0, rescan: 0 };
  const rows = documents.map((f) => {
    const tags = categorize(f);
    for (const t of tags) if (t in counts) counts[t]++;
    const md = f.metadata || {};
    return {
      fileId: String(f._id),
      fileName: f.fileName,
      status: f.status,
      stage: f.stage,
      pages: f.pageCount || null,
      fromPages: f.splitFrom ? f.splitFrom.pages : null,
      documentType: md.documentType || (f.classification && f.classification.suggestion && f.classification.suggestion.documentType) || null,
      documentTypeName: typeName(md.documentType || (f.classification && f.classification.suggestion && f.classification.suggestion.documentType) || '') || null,
      person: md.employeeName || (f.classification && f.classification.suggestion && f.classification.suggestion.person && f.classification.suggestion.person.match && f.classification.suggestion.person.match.name) || null,
      confirmed: f.metadataStatus === 'complete',
      tags,
      reasons: (f.reviewReasons || []).map((r) => r.message),
      error: f.error || '',
    };
  });
  const group = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key] || '(not set)';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].map(([label, n]) => ({ label, documents: n })).sort((a, b) => b.documents - a.documents);
  };
  return { files, received, documents: rows, pages, counts, pending, byType: group('documentTypeName'), byPerson: group('person') };
}

async function scanSummary(batchId, userId) {
  const batch = await loadScanBatch(batchId, userId);
  const s = await summarize(batch);
  const qc = batch.qc || null;
  return {
    batch: { _id: String(batch._id), name: batch.name, boxId: batch.boxId, expectedPages: batch.expectedPages, splitMode: batch.splitMode, status: batch.status, closedAt: batch.closedAt, completedAt: batch.completedAt, createdAt: batch.createdAt },
    pages: s.pages,
    counts: s.counts,
    pending: s.pending,
    documents: s.documents,
    byType: s.byType,
    byPerson: s.byPerson,
    qc: qc && qcSummary(qc),
  };
}

// ---------------------------------------------------------------- quality control
async function getQcSettings() {
  const s = await Setting.findOne({ key: 'qc' }).lean();
  return { percent: 10, ...((s && s.value) || {}) };
}
async function saveQcSettings(userId, patch = {}) {
  const v = await viewerFor(userId);
  if (!v || !v.isAdmin) throw new BatchError(403, 'Only administrators can change quality-control settings');
  const p = Number(patch.percent);
  if (!(p >= 1 && p <= 100)) throw new BatchError(400, 'The sample must be between 1% and 100%');
  const before = await getQcSettings();
  const next = { ...before, percent: p };
  await Setting.findOneAndUpdate({ key: 'qc' }, { value: next, updatedBy: userId }, { upsert: true });
  await emitAudit({ userId, action: 'settings.qc_changed', details: { before, after: next } });
  return next;
}

function qcSummary(qc) {
  const items = qc.items || [];
  return {
    percent: qc.percent,
    eligible: qc.eligible,
    sampledAt: qc.sampledAt,
    sampledBy: qc.sampledBy,
    items,
    passed: items.filter((i) => i.result === 'pass').length,
    failed: items.filter((i) => i.result === 'fail').length,
    pending: items.filter((i) => !i.result).length,
  };
}

/** Pick a random sample of the batch's documents (default: the configured %). */
async function sampleQc(batchId, { userId, percent, replace } = {}) {
  const batch = await loadScanBatch(batchId, userId);
  if (batch.qc && (batch.qc.items || []).some((i) => i.result) && !replace) throw new BatchError(409, 'This batch already has quality-check results — choose "new sample" to replace them');
  const pct = percent === undefined || percent === null || percent === '' ? (await getQcSettings()).percent : Number(percent);
  if (!(pct >= 1 && pct <= 100)) throw new BatchError(400, 'The sample must be between 1% and 100%');
  const s = await summarize(batch);
  const eligible = s.documents.filter((d) => ['ready', 'needs_review'].includes(d.status));
  if (!eligible.length) throw new BatchError(409, 'There are no finished documents to check yet');
  const n = Math.min(eligible.length, Math.max(1, Math.ceil((eligible.length * pct) / 100)));
  const pool = eligible.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const qc = { percent: pct, eligible: eligible.length, sampledAt: new Date(), sampledBy: String(userId), items: pool.slice(0, n).map((d) => ({ fileId: d.fileId, fileName: d.fileName, result: null, note: '', by: null, at: null })) };
  await Batch.updateOne({ _id: batch._id }, { qc });
  await emitAudit({ userId, action: 'batch.qc_sampled', details: { batchId: String(batch._id), percent: pct, eligible: eligible.length, sampled: n } });
  return qcSummary(qc);
}

const RESCAN = 'qc';
/** Record pass / fail for one sampled document; a fail marks it for rescanning. */
async function recordQc(batchId, fileId, { userId, result, note } = {}) {
  const batch = await loadScanBatch(batchId, userId);
  const qc = batch.qc;
  const item = qc && (qc.items || []).find((i) => i.fileId === String(fileId));
  if (!item) throw new BatchError(404, 'That document is not in the quality-check sample');
  if (!['pass', 'fail'].includes(result)) throw new BatchError(400, 'Choose pass or fail');
  const why = String(note || '').trim().slice(0, 500);
  if (result === 'fail' && !why) throw new BatchError(400, 'Say what is wrong (e.g. "page 2 is cut off") so it can be rescanned');
  Object.assign(item, { result, note: why, by: String(userId), at: new Date() });
  batch.qc = { ...qc };
  batch.markModified('qc');
  await batch.save();

  const file = await File.findById(fileId);
  if (file) {
    const others = (file.reviewReasons || []).filter((r) => r.stage !== RESCAN);
    if (result === 'fail') {
      file.rescan = { note: why, by: String(userId), at: new Date() };
      file.reviewReasons = [...others, { stage: RESCAN, code: 'RESCAN', message: `Failed the quality check: ${why} — rescan the paper original` }];
      file.status = 'needs_review';
    } else {
      file.rescan = null;
      file.reviewReasons = others;
      if (file.status === 'needs_review' && !others.length) file.status = 'ready';
    }
    await file.save();
    events.emit('document.changed', String(file._id));
  }
  await emitAudit({ userId, action: 'batch.qc_result', documentId: fileId, details: { batchId: String(batch._id), result, note: why } });
  events.emit('batch.touch', String(batch._id));
  return qcSummary(batch.qc);
}

// ---------------------------------------------------------------- reconciliation
async function reconciliation(batchId, userId) {
  const batch = await loadScanBatch(batchId, userId);
  const s = await summarize(batch);
  const who = async (id) => {
    const u = id && isId(id) ? await User.findById(id).select('firstName lastName email').lean() : null;
    return u ? `${[u.firstName, u.lastName].filter(Boolean).join(' ') || u.email}` : '';
  };
  const exceptions = [];
  for (const f of s.received) if (f.status === 'failed') exceptions.push({ kind: 'Failed', fileName: f.fileName, detail: f.error || 'Could not be processed' });
  for (const d of s.documents) {
    if (d.tags.includes('rescan')) exceptions.push({ kind: 'Rescan', fileName: d.fileName, detail: d.reasons.find((r) => /quality check/.test(r)) || '' });
    if (d.tags.includes('duplicate')) exceptions.push({ kind: 'Possible duplicate', fileName: d.fileName, detail: d.reasons.find((r) => /Same|duplicate/i.test(r)) || '' });
    if (d.tags.includes('split_suggested')) exceptions.push({ kind: 'Split not decided', fileName: d.fileName, detail: d.reasons[0] || '' });
    if (d.status === 'needs_review' && !d.tags.some((t) => ['rescan', 'duplicate', 'split_suggested'].includes(t)))
      exceptions.push({ kind: 'Needs review', fileName: d.fileName, detail: d.reasons.join('; ') });
  }
  if (s.pages.expected && s.pages.received !== s.pages.expected)
    exceptions.unshift({ kind: 'Page count', fileName: '', detail: `${s.pages.received} pages received, ${s.pages.expected} expected (${s.pages.received - s.pages.expected > 0 ? '+' : ''}${s.pages.received - s.pages.expected})` });
  if (s.pages.missing) exceptions.unshift({ kind: 'Missing pages', fileName: '', detail: `${s.pages.missing} page(s) received but not in any document or removal record` });
  const qc = batch.qc ? qcSummary(batch.qc) : null;
  return {
    batch: { name: batch.name, boxId: batch.boxId, id: String(batch._id), status: batch.status, splitMode: batch.splitMode },
    createdBy: await who(batch.createdBy),
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    generatedBy: await who(userId),
    generatedAt: new Date(),
    pending: s.pending,
    pages: s.pages,
    counts: s.counts,
    byType: s.byType,
    byPerson: s.byPerson,
    exceptions,
    qc,
    documents: s.documents,
  };
}

const fmt = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no formulas when opened in Excel
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function reconciliationCsv(batchId, userId) {
  const r = await reconciliation(batchId, userId);
  const rows = [
    ['Reconciliation report', r.batch.name],
    ['Box / folder ID', r.batch.boxId],
    ['Batch ID', r.batch.id],
    ['Started by', r.createdBy],
    ['Started', fmt(r.createdAt)],
    ['Completed', fmt(r.completedAt)],
    ['Report by', r.generatedBy],
    ['Report generated', fmt(r.generatedAt)],
    ['Still processing', r.pending ? 'yes — figures are provisional' : 'no'],
    [],
    ['Pages', 'Count'],
    ['Expected', r.pages.expected ?? ''],
    ['Received', r.pages.received],
    ['In documents', r.pages.inDocuments],
    ['Removed (separator sheets, blank pages)', r.pages.removed],
    ['Missing', r.pages.missing ?? 'pending'],
    [],
    ['Documents', 'Count'],
    ['Files received', r.counts.received],
    ['Documents created', r.counts.documents],
    ['Ready', r.counts.ready],
    ['Needs review', r.counts.needs_review],
    ['Restricted', r.counts.restricted],
    ['Possible duplicates', r.counts.duplicate],
    ['Failed', r.counts.failed],
    ['Marked for rescan', r.counts.rescan],
    [],
    ['Document type', 'Documents'],
    ...r.byType.map((g) => [g.label, g.documents]),
    [],
    ['Person', 'Documents'],
    ...r.byPerson.map((g) => [g.label, g.documents]),
    [],
    ['Quality check', r.qc ? `${r.qc.items.length} of ${r.qc.eligible} documents (${r.qc.percent}%)` : 'not sampled'],
    ...(r.qc ? [['Passed', r.qc.passed], ['Failed', r.qc.failed], ['Not checked yet', r.qc.pending], ...r.qc.items.map((i) => [`  ${i.fileName}`, i.result || 'not checked', i.note])] : []),
    [],
    ['Exception', 'Document', 'Detail'],
    ...(r.exceptions.length ? r.exceptions.map((e) => [e.kind, e.fileName, e.detail]) : [['None']]),
    [],
    ['Document', 'Pages', 'From original pages', 'Type', 'Person', 'Status', 'Flags'],
    ...r.documents.map((d) => [d.fileName, d.pages ?? '', d.fromPages ? d.fromPages.join(' ') : '', d.documentTypeName || '', d.person || '', d.status, d.tags.filter((t) => !['ready', 'needs_review'].includes(t)).join(' ')]),
  ];
  await emitAudit({ userId, action: 'batch.report_generated', details: { batchId: r.batch.id, format: 'csv', missingPages: r.pages.missing } });
  return { filename: `reconciliation-${(r.batch.boxId || r.batch.name).replace(/[^\w.-]+/g, '_')}.csv`, csv: `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n` };
}

async function reconciliationPdf(batchId, userId) {
  const r = await reconciliation(batchId, userId);
  const L = [];
  L.push(`RECONCILIATION REPORT`, `${r.batch.name}${r.batch.boxId ? `  ·  Box ${r.batch.boxId}` : ''}`, '');
  L.push(`Started by ${r.createdBy} on ${fmt(r.createdAt)}. Completed: ${r.completedAt ? fmt(r.completedAt) : 'not yet'}.`, `Report generated by ${r.generatedBy} on ${fmt(r.generatedAt)}.`);
  if (r.pending) L.push('NOTE: some files are still processing — the figures below are provisional.');
  L.push('', 'PAGES');
  L.push(`  Expected ............................ ${r.pages.expected ?? '—'}`);
  L.push(`  Received ............................ ${r.pages.received}`);
  L.push(`  In documents ........................ ${r.pages.inDocuments}`);
  L.push(`  Removed (separator / blank pages) ... ${r.pages.removed}`);
  L.push(`  Missing ............................. ${r.pages.missing ?? 'pending'}`);
  L.push('', 'DOCUMENTS');
  L.push(`  ${r.counts.received} file(s) received, ${r.counts.documents} document(s) created: ${r.counts.ready} ready, ${r.counts.needs_review} need review, ${r.counts.failed} failed`);
  L.push(`  Restricted: ${r.counts.restricted}   Possible duplicates: ${r.counts.duplicate}   Marked for rescan: ${r.counts.rescan}`);
  L.push('', 'BY DOCUMENT TYPE', ...r.byType.map((g) => `  ${g.label}: ${g.documents}`));
  L.push('', 'BY PERSON', ...r.byPerson.map((g) => `  ${g.label}: ${g.documents}`));
  L.push('', 'QUALITY CHECK');
  if (r.qc) {
    L.push(`  Sample: ${r.qc.items.length} of ${r.qc.eligible} documents (${r.qc.percent}%), drawn ${fmt(r.qc.sampledAt)}`);
    L.push(`  Passed ${r.qc.passed} · Failed ${r.qc.failed} · Not checked ${r.qc.pending}`);
    for (const i of r.qc.items) L.push(`  - ${i.fileName}: ${i.result || 'not checked'}${i.note ? ` (${i.note})` : ''}`);
  } else L.push('  Not sampled.');
  L.push('', 'EXCEPTIONS');
  if (!r.exceptions.length) L.push('  None.');
  for (const e of r.exceptions) L.push(`  - ${e.kind}${e.fileName ? `: ${e.fileName}` : ''}${e.detail ? ` — ${e.detail}` : ''}`);
  L.push('', 'DOCUMENTS CREATED');
  for (const d of r.documents) L.push(`  - ${d.fileName} · ${d.pages ?? '?'} p${d.fromPages ? ` (original pages ${d.fromPages.join(', ')})` : ''} · ${d.documentTypeName || 'type not set'} · ${d.person || 'person not set'} · ${d.status.replace('_', ' ')}`);
  const { pdf } = await textToPdf(L.join('\n'), { title: `Reconciliation · ${r.batch.name}`, maxPages: 200 });
  await emitAudit({ userId, action: 'batch.report_generated', details: { batchId: r.batch.id, format: 'pdf', missingPages: r.pages.missing } });
  return { filename: `reconciliation-${(r.batch.boxId || r.batch.name).replace(/[^\w.-]+/g, '_')}.pdf`, pdf };
}

module.exports = {
  createScanBatch,
  openScanBatchForBox,
  scanSummary,
  sampleQc,
  recordQc,
  getQcSettings,
  saveQcSettings,
  reconciliation,
  reconciliationCsv,
  reconciliationPdf,
};
