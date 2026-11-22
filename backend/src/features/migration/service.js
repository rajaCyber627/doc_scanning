// Import from shared drives (P16) — a safe, repeatable migration of HR network folders and
// SharePoint libraries, with the reports the RFP's Data Migration section asks for:
//   1 inventory   (read-only discovery: path, size, type, dates, owner, hash, problems)
//   2 map         (rules file → person / metadata per file; dry run lists the unmapped)
//   3 migrate     (test subset, then production; normal pipeline; resumable, rate-limited,
//                  idempotent through a ledger keyed on source + path + hash)
//   4 reconcile   (source vs imported vs skipped vs failed, with reasons; hash verification)
// The source is never modified: files are only listed and read.
const crypto = require('crypto');
const mongoose = require('mongoose');
const config = require('../../core/config');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { viewerFor } = require('../../core/access');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const User = require('../../models/User');
const Batch = require('../../models/Batch');
const metadata = require('../metadata/service');
const { typeForName, contentMatches, mismatchReason, isExecutableName, extOf } = require('../upload/fileTypes');
const { MigrationRun, MigrationItem, MigrationLedger } = require('./models');
const { compileRules, mapPath } = require('./mapping');
const { localSource } = require('./sources/local');
const { sharepointSource } = require('./sources/sharepoint');

class MigrationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isId = (v) => mongoose.isValidObjectId(v);

function sourceFor(run) {
  if (run.source.kind === 'local') return localSource(run.source.root);
  return sharepointSource({ ...config.emailIntake.graph, driveId: run.source.driveId, folder: run.source.root });
}

async function loadRun(runId) {
  if (!isId(runId)) throw new MigrationError(404, 'Migration run not found');
  const run = await MigrationRun.findById(runId);
  if (!run) throw new MigrationError(404, 'Migration run not found');
  return run;
}

// ---------------------------------------------------------------- create
async function createRun({ name, kind = 'local', root = '', driveId = '', ownerEmail, startedBy = 'cli' } = {}) {
  const owner = await User.findOne({ email: String(ownerEmail || '').trim().toLowerCase() }).select('_id').lean();
  if (!owner) throw new MigrationError(400, 'Give the email of the staff member who will own the imported documents (--owner)');
  if (kind === 'local' && !root) throw new MigrationError(400, 'Give the folder to import (--root)');
  if (kind === 'sharepoint' && !driveId) throw new MigrationError(400, 'Give the SharePoint document library drive id (--drive)');
  const src = kind === 'local' ? localSource(root) : sharepointSource({ ...config.emailIntake.graph, driveId, folder: root });
  const run = await MigrationRun.create({
    name: String(name || '').trim() || `Import ${src.label}`,
    source: { kind, root, driveId, label: src.label },
    sourceKey: src.key,
    ownerId: owner._id,
    startedBy,
  });
  await emitAudit({ userId: owner._id, action: 'migration.created', details: { runId: String(run._id), source: src.label } });
  return run;
}

// ---------------------------------------------------------------- 1 inventory
const AGE = [
  ['under 1 year', 1],
  ['1–3 years', 3],
  ['3–7 years', 7],
  ['over 7 years', Infinity],
];
async function hashOf(src, item) {
  const h = crypto.createHash('sha256');
  const head = [];
  let headLen = 0;
  const stream = await src.stream(item);
  for await (const chunk of stream) {
    h.update(chunk);
    if (headLen < 4096) {
      head.push(chunk);
      headLen += chunk.length;
    }
  }
  return { sha256: h.digest('hex'), head: Buffer.concat(head).subarray(0, 4096) };
}

async function inventory(runId, { onProgress } = {}) {
  const run = await loadRun(runId);
  const src = sourceFor(run);
  await MigrationItem.deleteMany({ runId: run._id, status: 'pending' }); // a re-inventory refreshes what is not yet imported
  const firstBySha = new Map();
  for (const done of await MigrationItem.find({ runId: run._id, status: { $ne: 'pending' } }).select('path sha256').lean()) if (done.sha256) firstBySha.set(done.sha256, done.path);
  let n = 0;
  for await (const e of src.walk()) {
    const exists = await MigrationItem.exists({ runId: run._id, path: e.path });
    if (exists) continue; // already processed in an earlier pass
    const doc = { runId: run._id, path: e.path, sourceId: e.sourceId || '', size: e.size || 0, ext: extOf(e.path), created: e.created, modified: e.modified, owner: e.owner || '' };
    const name = e.path.split('/').pop();
    if (e.unreadable) Object.assign(doc, { issue: 'unreadable', issueDetail: `Folder could not be read: ${e.error}` });
    else {
      const type = typeForName(name);
      try {
        const { sha256, head } = await hashOf(src, e);
        doc.sha256 = sha256;
        if (isExecutableName(name)) Object.assign(doc, { issue: 'unsupported', issueDetail: 'Programs and scripts are never imported' });
        else if (!type) Object.assign(doc, { issue: 'unsupported', issueDetail: `.${doc.ext || '?'} files are not a supported type` });
        else if (!doc.size) Object.assign(doc, { issue: 'empty', issueDetail: 'Empty file' });
        else if (doc.size > config.upload.maxBytes) Object.assign(doc, { issue: 'too_large', issueDetail: 'Larger than the upload limit' });
        else if (!contentMatches(type, head)) Object.assign(doc, { issue: 'damaged', issueDetail: mismatchReason(type, head, name) });
        if (!doc.issue) {
          if (firstBySha.has(sha256)) doc.duplicateOf = firstBySha.get(sha256);
          else firstBySha.set(sha256, e.path);
        }
      } catch (err) {
        Object.assign(doc, { issue: 'unreadable', issueDetail: err.code || err.message });
      }
    }
    await MigrationItem.create(doc);
    n++;
    if (onProgress && n % 100 === 0) onProgress(n);
  }
  const summary = await inventorySummary(run._id);
  run.status = 'inventoried';
  run.summary = { ...(run.summary || {}), inventory: summary };
  run.markModified('summary');
  await run.save();
  await emitAudit({ userId: run.ownerId, action: 'migration.inventoried', details: { runId: String(run._id), files: summary.files, bytes: summary.bytes } });
  return summary;
}

async function inventorySummary(runId) {
  const items = await MigrationItem.find({ runId }).select('ext size modified issue duplicateOf').lean();
  const byType = {};
  const byAge = Object.fromEntries(AGE.map(([k]) => [k, 0]));
  const issues = {};
  let bytes = 0;
  const now = Date.now();
  for (const it of items) {
    const t = it.ext || '(none)';
    byType[t] = byType[t] || { files: 0, bytes: 0 };
    byType[t].files++;
    byType[t].bytes += it.size || 0;
    bytes += it.size || 0;
    if (it.modified) {
      const years = (now - new Date(it.modified).getTime()) / (365.25 * 86400000);
      byAge[AGE.find(([, max]) => years < max)[0]]++;
    }
    if (it.issue) issues[it.issue] = (issues[it.issue] || 0) + 1;
  }
  return { files: items.length, bytes, byType, byAge, issues, likelyDuplicates: items.filter((i) => i.duplicateOf).length, importable: items.filter((i) => !i.issue && !i.duplicateOf).length, at: new Date() };
}

// ---------------------------------------------------------------- 2 mapping (dry run)
async function map(runId, rulesConfig) {
  const run = await loadRun(runId);
  let compiled;
  try {
    compiled = compileRules(rulesConfig);
  } catch (e) {
    throw new MigrationError(400, e.message);
  }
  const tax = await metadata.getTaxonomy();
  const cache = new Map();
  const counts = { mapped: 0, unmapped: 0, withProblems: 0, byRule: {} };
  const cursor = MigrationItem.find({ runId: run._id, issue: '' }).cursor();
  for await (const it of cursor) {
    const m = await mapPath(compiled, it.path, tax, cache);
    it.mapping = m;
    await MigrationItem.updateOne({ _id: it._id }, { mapping: m });
    if (!m) counts.unmapped++;
    else {
      counts.mapped++;
      counts.byRule[m.rule] = (counts.byRule[m.rule] || 0) + 1;
      if (m.problems.length) counts.withProblems++;
    }
  }
  run.mapping = rulesConfig;
  run.status = 'mapped';
  run.summary = { ...(run.summary || {}), mapping: { ...counts, requireMapping: compiled.requireMapping, at: new Date() } };
  run.markModified('summary');
  await run.save();
  await emitAudit({ userId: run.ownerId, action: 'migration.mapped', details: { runId: String(run._id), mapped: counts.mapped, unmapped: counts.unmapped } });
  return run.summary.mapping;
}

// ---------------------------------------------------------------- 3 migrate
/**
 * @param opts.mode    'test' | 'production'
 * @param opts.limit   test: at most this many files
 * @param opts.prefix  test: only paths starting with this
 * @param opts.ratePerSec files per second (default config / 5)
 */
async function migrate(runId, { mode = 'test', limit = 0, prefix = '', ratePerSec, onProgress } = {}) {
  const run = await loadRun(runId);
  if (!['inventoried', 'mapped', 'migrating', 'migrated', 'reconciled'].includes(run.status)) throw new MigrationError(409, 'Run the inventory first');
  if (!['test', 'production'].includes(mode)) throw new MigrationError(400, 'Mode is test or production');
  const requireMapping = !!(run.summary && run.summary.mapping && run.summary.mapping.requireMapping);
  const src = sourceFor(run);
  const rate = Number(ratePerSec) || config.migration.ratePerSec;
  const gap = rate > 0 ? 1000 / rate : 0;
  if (!run.batchId) {
    const b = await Batch.create({ name: `Import · ${run.name}`, source: 'import', createdBy: run.ownerId, items: [] });
    run.batchId = b._id;
  }
  run.status = 'migrating';
  await run.save();
  await emitAudit({ userId: run.ownerId, action: 'migration.started', details: { runId: String(run._id), mode, limit: limit || null, prefix: prefix || null } });

  const q = { runId: run._id, status: 'pending' };
  if (prefix) q.path = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const pass = { mode, imported: 0, skipped: 0, failed: 0, at: new Date() };
  let n = 0;
  const cursor = MigrationItem.find(q).sort({ path: 1 }).cursor();
  for await (const it of cursor) {
    if (mode === 'test' && limit && n >= limit) break;
    n++;
    const t0 = Date.now();
    const r = await migrateOne(run, src, it, mode, requireMapping);
    pass[r]++;
    if (onProgress && n % 25 === 0) onProgress(n);
    const wait = gap - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  const left = await MigrationItem.countDocuments({ runId: run._id, status: 'pending' });
  run.status = left ? 'migrating' : 'migrated';
  run.summary = { ...(run.summary || {}), migration: [...((run.summary && run.summary.migration) || []), pass] };
  run.markModified('summary');
  await run.save();
  await emitAudit({ userId: run.ownerId, action: 'migration.pass_completed', details: { runId: String(run._id), ...pass, pending: left } });
  events.emit('batch.touch', String(run.batchId));
  return { ...pass, pending: left };
}

const skip = async (it, reason) => {
  await MigrationItem.updateOne({ _id: it._id }, { status: 'skipped', reason });
  return 'skipped';
};

async function migrateOne(run, src, it, mode, requireMapping) {
  if (it.issue) return skip(it, it.issueDetail || it.issue);
  if (it.duplicateOf) return skip(it, `Same file as ${it.duplicateOf} (imported once)`);
  if (requireMapping && !it.mapping) return skip(it, 'No mapping rule matches this path');
  const done = await MigrationLedger.findOne({ sourceKey: run.sourceKey, path: it.path, sha256: it.sha256 }).lean();
  if (done) {
    await MigrationItem.updateOne({ _id: it._id }, { status: 'skipped', reason: 'Already imported in an earlier run', fileId: done.fileId });
    return 'skipped';
  }
  try {
    const buf = await src.read(it);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== it.sha256) throw new Error('The file changed since the inventory — run the inventory again');
    const name = it.path.split('/').pop();
    const type = typeForName(name);
    const s3Key = `${run.ownerId}/import/${run._id}/${crypto.randomBytes(4).toString('hex')}-${name.replace(/[^\w.\- ]+/g, '_').slice(-150)}`;
    await storage.putStream(s3Key, buf, type.mime);
    const m = it.mapping || {};
    const prefill = {};
    if (m.documentType) prefill.documentType = m.documentType;
    if (m.personId) prefill.personId = m.personId;
    else if (m.employeeId) prefill.employeeId = m.employeeId;
    // claim the ledger entry first: a second process can never import the same file
    let ledger;
    try {
      ledger = await MigrationLedger.create({ sourceKey: run.sourceKey, path: it.path, sha256: sha, runId: run._id });
    } catch (e) {
      if (e && e.code === 11000) {
        await storage.deleteObject(s3Key).catch(() => {});
        return skip(it, 'Already imported in an earlier run');
      }
      throw e;
    }
    const file = await File.create({
      userId: run.ownerId,
      batchId: run.batchId,
      fileName: name,
      s3Key,
      mimeType: type.mime,
      sizeBytes: buf.length,
      sha256: sha,
      source: 'import',
      status: 'processing',
      prefill: Object.keys(prefill).length ? prefill : null,
      metadata: {
        migration: { runId: String(run._id), source: run.source.label, path: it.path, created: it.created, modified: it.modified, owner: it.owner, mode, rule: m.rule || null, folderValues: m.values || null },
      },
    });
    await MigrationLedger.updateOne({ _id: ledger._id }, { fileId: file._id });
    await MigrationItem.updateOne({ _id: it._id }, { status: 'imported', mode, fileId: file._id, reason: '' });
    await emitAudit({ userId: run.ownerId, action: 'migration.imported', documentId: file._id, details: { runId: String(run._id), sourcePath: it.path, source: run.source.label, mode } });
    require('../intake/pipeline').enqueueDocument(file._id);
    return 'imported';
  } catch (e) {
    await MigrationItem.updateOne({ _id: it._id }, { status: 'failed', reason: e.message.slice(0, 300) });
    return 'failed';
  }
}

// ---------------------------------------------------------------- 4 reconcile
async function reconcile(runId, { verify = true } = {}) {
  const run = await loadRun(runId);
  const items = await MigrationItem.find({ runId: run._id }).lean();
  const out = { source: items.length, imported: 0, skipped: 0, failed: 0, pending: 0, skippedBy: {}, failedBy: {}, pipeline: {}, verified: { match: 0, mismatch: 0, missing: 0 }, at: new Date() };
  const fileIds = items.filter((i) => i.fileId).map((i) => i.fileId);
  const files = new Map((await File.find({ _id: { $in: fileIds } }).select('status s3Key sha256').lean()).map((f) => [String(f._id), f]));
  for (const it of items) {
    out[it.status]++;
    if (it.status === 'skipped') out.skippedBy[bucket(it.reason)] = (out.skippedBy[bucket(it.reason)] || 0) + 1;
    if (it.status === 'failed') out.failedBy[it.reason] = (out.failedBy[it.reason] || 0) + 1;
    if (it.status === 'imported') {
      const f = files.get(String(it.fileId));
      out.pipeline[f ? f.status : 'deleted'] = (out.pipeline[f ? f.status : 'deleted'] || 0) + 1;
      if (verify) {
        let v = 'missing';
        if (f) {
          try {
            const stored = await storage.s3GetBuffer(f.s3Key);
            v = crypto.createHash('sha256').update(stored).digest('hex') === it.sha256 ? 'match' : 'mismatch';
          } catch {
            v = 'missing';
          }
        }
        out.verified[v]++;
        await MigrationItem.updateOne({ _id: it._id }, { verified: v });
      }
    }
  }
  out.accountedFor = out.imported + out.skipped + out.failed + out.pending === out.source;
  run.status = out.pending ? run.status : 'reconciled';
  run.summary = { ...(run.summary || {}), reconciliation: out };
  run.markModified('summary');
  await run.save();
  await emitAudit({ userId: run.ownerId, action: 'migration.reconciled', details: { runId: String(run._id), source: out.source, imported: out.imported, skipped: out.skipped, failed: out.failed, pending: out.pending, mismatches: out.verified.mismatch } });
  return out;
}
function bucket(reason) {
  if (/^Same file as/.test(reason)) return 'Duplicate within the source';
  if (/^Already imported/.test(reason)) return 'Already imported in an earlier run';
  return reason;
}

// ---------------------------------------------------------------- reports (CSV)
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

async function report(runId, kind) {
  const run = await loadRun(runId);
  const items = await MigrationItem.find({ runId: run._id }).sort({ path: 1 }).lean();
  const head = [['Run', run.name], ['Source', run.source.label], ['Report', kind], ['Generated', new Date().toISOString()], []];
  let rows;
  if (kind === 'inventory') {
    const s = run.summary.inventory || (await inventorySummary(run._id));
    rows = [
      ...head,
      ['Files', s.files],
      ['Total size (bytes)', s.bytes],
      ['Importable', s.importable],
      ['Likely duplicates', s.likelyDuplicates],
      ...Object.entries(s.issues || {}).map(([k, v]) => [`Problem: ${k}`, v]),
      [],
      ['Type', 'Files', 'Bytes'],
      ...Object.entries(s.byType).map(([k, v]) => [k, v.files, v.bytes]),
      [],
      ['Age (last modified)', 'Files'],
      ...Object.entries(s.byAge),
      [],
      ['Path', 'Size', 'Type', 'Created', 'Modified', 'Owner', 'SHA-256', 'Problem', 'Duplicate of'],
      ...items.map((i) => [i.path, i.size, i.ext, i.created, i.modified, i.owner, i.sha256, i.issueDetail || i.issue, i.duplicateOf]),
    ];
  } else if (kind === 'mapping') {
    rows = [
      ...head,
      ['Path', 'Rule', 'Employee ID', 'Person (directory)', 'Document type', 'Problems'],
      ...items.filter((i) => !i.issue).map((i) => (i.mapping ? [i.path, i.mapping.rule, i.mapping.employeeId || i.mapping.applicantNumber || '', i.mapping.personName || '', i.mapping.documentType || '', (i.mapping.problems || []).join('; ')] : [i.path, 'UNMAPPED', '', '', '', 'No rule matches this path'])),
    ];
  } else {
    const r = run.summary.reconciliation || (await reconcile(run._id, { verify: false }));
    rows = [
      ...head,
      ['Files in source', r.source],
      ['Imported', r.imported],
      ['Skipped', r.skipped],
      ['Failed', r.failed],
      ['Not yet migrated', r.pending],
      ['Every file accounted for', r.accountedFor ? 'yes' : 'NO'],
      ['Verified by hash', r.verified.match],
      ['Hash mismatch', r.verified.mismatch],
      ['Missing after import', r.verified.missing],
      [],
      ['Skipped because', 'Files'],
      ...Object.entries(r.skippedBy || {}),
      [],
      ['Failed because', 'Files'],
      ...Object.entries(r.failedBy || {}),
      [],
      ['Path', 'Outcome', 'Reason', 'Mode', 'Document', 'Hash check'],
      ...items.map((i) => [i.path, i.status, i.reason, i.mode, i.fileId ? String(i.fileId) : '', i.verified]),
    ];
  }
  await emitAudit({ userId: run.ownerId, action: 'migration.report_generated', details: { runId: String(run._id), kind } });
  return { filename: `${kind}-${run.name.replace(/[^\w.-]+/g, '_')}.csv`, csv: toCsv(rows) };
}

// ---------------------------------------------------------------- admin views
async function requireAdmin(userId) {
  const v = await viewerFor(userId);
  if (!v || !v.isAdmin) throw new MigrationError(403, 'Only administrators can view migrations');
}
async function listRuns(userId) {
  await requireAdmin(userId);
  return MigrationRun.find({}).sort({ createdAt: -1 }).limit(100).lean();
}
async function getRun(userId, runId) {
  await requireAdmin(userId);
  const run = (await loadRun(runId)).toObject();
  const [byStatus, unmapped, failed] = await Promise.all([
    MigrationItem.aggregate([{ $match: { runId: run._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    MigrationItem.find({ runId: run._id, issue: '', mapping: null }).select('path').limit(50).lean(),
    MigrationItem.find({ runId: run._id, status: 'failed' }).select('path reason').limit(50).lean(),
  ]);
  return { run, items: Object.fromEntries(byStatus.map((x) => [x._id, x.n])), unmapped: unmapped.map((u) => u.path), failed };
}
async function adminReport(userId, runId, kind) {
  await requireAdmin(userId);
  if (!['inventory', 'mapping', 'reconciliation'].includes(kind)) throw new MigrationError(404, 'Unknown report');
  return report(runId, kind);
}

module.exports = { createRun, inventory, inventorySummary, map, migrate, reconcile, report, listRuns, getRun, adminReport, MigrationError };
