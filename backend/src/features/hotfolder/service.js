// Scanner hot folders (P13): office scanners and copiers save into a network folder or an
// S3 prefix; every new file is imported as a document (source = scanner) — no software on
// any PC. A profile maps one folder to the staff member who owns its documents, and
// optionally to a batch per sub-folder or per day.
//
//   local profile: <HOTFOLDER_ROOT>/<path>/[sub-folder/]scan.pdf   (e.g. a mounted SMB share)
//   s3 profile:    s3://<bucket>/<prefix>/[sub-folder/]scan.pdf
// Imported files are moved to ".imported/<date>/" and unsupported ones to ".rejected/",
// so the folder shows staff what happened; every attempt is also recorded (HotFolderImport).
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../../core/config');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { viewerFor } = require('../../core/access');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const User = require('../../models/User');
const Batch = require('../../models/Batch');
const Setting = require('../../models/Setting');
const HotFolderImport = require('./HotFolderImport.model');
const { typeForName, contentMatches, mismatchReason, isExecutableName } = require('../upload/fileTypes');

const DONE_DIR = '.imported';
const REJECT_DIR = '.rejected';
const NAME_RE = /^[a-z0-9][a-z0-9 _.-]{0,59}$/i;

class HotFolderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- profiles
async function getProfiles() {
  const s = await Setting.findOne({ key: 'hotfolders' }).lean();
  return (s && Array.isArray(s.value) && s.value) || [];
}

async function requireAdmin(userId) {
  const v = await viewerFor(userId);
  if (!v || !v.isAdmin) throw new HotFolderError(403, 'Only administrators can manage scanner folders');
  return v;
}

/** Resolve a local profile path inside HOTFOLDER_ROOT (never anywhere else on the server). */
function localDir(p) {
  if (!config.hotfolder.root) throw new HotFolderError(400, 'Local scanner folders need HOTFOLDER_ROOT to be set on the server');
  const root = path.resolve(config.hotfolder.root);
  const dir = path.resolve(root, String(p || ''));
  if (dir !== root && !dir.startsWith(root + path.sep)) throw new HotFolderError(400, 'The folder must be inside the scanner share');
  return dir;
}

async function validateProfile(p, i) {
  const where = `Folder ${i + 1}`;
  const name = String((p && p.name) || '').trim();
  if (!NAME_RE.test(name)) throw new HotFolderError(400, `${where}: give it a short name (letters, digits, spaces, - _ .)`);
  const kind = p.kind === 's3' ? 's3' : 'local';
  const out = { name, kind, enabled: p.enabled !== false, batchMode: ['none', 'subfolder', 'daily'].includes(p.batchMode) ? p.batchMode : 'subfolder' };
  if (kind === 'local') {
    out.path = String(p.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    localDir(out.path); // throws when outside the root
  } else {
    const prefix = String(p.prefix || '').replace(/^\/+/, '');
    if (!prefix || prefix.includes('..')) throw new HotFolderError(400, `${where}: enter the S3 prefix the scanners save to (e.g. scanners/hr-copier/)`);
    out.prefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  }
  const owner = p.ownerEmail ? await User.findOne({ email: String(p.ownerEmail).toLowerCase().trim() }).select('_id email').lean() : p.ownerId ? await User.findById(p.ownerId).select('_id email').lean() : null;
  if (!owner) throw new HotFolderError(400, `${where}: choose the staff member who owns the scanned documents (their email)`);
  out.ownerId = String(owner._id);
  out.ownerEmail = owner.email;
  return out;
}

async function saveProfiles(userId, profiles) {
  await requireAdmin(userId);
  if (!Array.isArray(profiles) || profiles.length > 50) throw new HotFolderError(400, 'Send up to 50 scanner folders');
  const clean = [];
  for (const [i, p] of profiles.entries()) clean.push(await validateProfile(p, i));
  const names = clean.map((p) => p.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new HotFolderError(400, 'Each scanner folder needs a different name');
  const before = await getProfiles();
  await Setting.findOneAndUpdate({ key: 'hotfolders' }, { value: clean, updatedBy: userId }, { upsert: true });
  await emitAudit({ userId, action: 'settings.hotfolders_changed', details: { before: before.map((p) => p.name), after: clean.map((p) => `${p.name} (${p.kind})`) } });
  return clean;
}

// ---------------------------------------------------------------- sources
// Each source lists candidate files and can read / move them.
function localSource(profile) {
  const dir = localDir(profile.path);
  return {
    async list() {
      const out = [];
      const walk = async (d, rel) => {
        let entries;
        try {
          entries = await fs.readdir(d, { withFileTypes: true });
        } catch (e) {
          if (e.code === 'ENOENT') throw new HotFolderError(404, `The folder "${profile.path || '/'}" does not exist`);
          throw e;
        }
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name.startsWith('~')) continue; // ours, hidden, temp
          const abs = path.join(d, e.name);
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!rel) await walk(abs, r); // one level of sub-folders (batch per sub-folder)
          } else if (e.isFile()) {
            const st = await fs.stat(abs);
            out.push({ id: r, rel: r, size: st.size, mtime: st.mtime });
          }
        }
      };
      await walk(dir, '');
      return out;
    },
    read: (f) => fs.readFile(path.join(dir, f.rel)),
    async move(f, toDir) {
      const day = new Date().toISOString().slice(0, 10);
      const target = path.join(dir, toDir, day, f.rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      let dest = target;
      for (let n = 1; await fs.access(dest).then(() => true, () => false); n++) dest = target.replace(/(\.[^.]+)?$/, ` (${n})$1`);
      await fs.rename(path.join(dir, f.rel), dest);
    },
  };
}

function s3Source(profile) {
  return {
    async list() {
      const all = await storage.listObjects(profile.prefix, 5000);
      return all
        .filter((o) => !o.key.endsWith('/'))
        .map((o) => ({ id: o.key, rel: o.key.slice(profile.prefix.length), size: o.size, mtime: o.lastModified }))
        .filter((f) => f.rel && !f.rel.split('/').some((seg) => seg.startsWith('.')) && f.rel.split('/').length <= 2);
    },
    read: (f) => storage.s3GetBuffer(f.id),
    async move(f, toDir) {
      const day = new Date().toISOString().slice(0, 10);
      const buf = await storage.s3GetBuffer(f.id);
      await storage.putStream(`${profile.prefix}${toDir}/${day}/${f.rel}`, buf, 'application/octet-stream');
      await storage.deleteObject(f.id);
    },
  };
}

const sourceFor = (profile) => (profile.kind === 's3' ? s3Source(profile) : localSource(profile));

// ---------------------------------------------------------------- import
async function batchFor(profile, sub) {
  // a scan batch started for this box (sub-folder named after its box ID) takes the files
  const scanBatch = sub ? await require('../batches/scan').openScanBatchForBox(profile.ownerId, sub) : null;
  if (scanBatch) return scanBatch;
  if (profile.batchMode === 'none') return null;
  const day = new Date().toISOString().slice(0, 10);
  const label = profile.batchMode === 'daily' || !sub ? day : sub;
  const name = `Scanner · ${profile.name} · ${label}`;
  const existing = await Batch.findOne({ name, createdBy: profile.ownerId, source: 'scanner', status: { $ne: 'completed' } });
  if (existing) return existing;
  const b = await Batch.create({ name, source: 'scanner', createdBy: profile.ownerId, items: [] });
  await emitAudit({ userId: profile.ownerId, action: 'batch.created', details: { batchId: String(b._id), name, source: 'scanner', folder: profile.name } });
  return b;
}

const safeKeyName = (name) => String(name).replace(/[^\w.\- ]+/g, '_').slice(-150);

async function importOne(profile, src, f) {
  const key = { profile: profile.name, path: f.rel, size: f.size, mtime: f.mtime ? new Date(f.mtime) : null };
  if (await HotFolderImport.exists(key)) return { skipped: true };
  const fileName = path.posix.basename(f.rel);
  const sub = f.rel.includes('/') ? f.rel.split('/')[0] : null;
  const type = typeForName(fileName);
  let reason = null;
  if (isExecutableName(fileName)) reason = 'Programs and scripts are never imported';
  else if (!type) reason = 'Unsupported file type';
  else if (!f.size) reason = 'Empty file';
  else if (f.size > config.upload.maxBytes) reason = 'Larger than the upload limit';
  let buf = null;
  if (!reason) {
    buf = await src.read(f);
    if (!contentMatches(type, buf.subarray(0, 4096))) reason = mismatchReason(type, buf.subarray(0, 4096), fileName);
  }
  if (reason) {
    await src.move(f, REJECT_DIR).catch(() => {});
    await HotFolderImport.create({ ...key, status: 'rejected', reason });
    await emitAudit({ userId: profile.ownerId, action: 'capture.rejected', details: { source: 'scanner', device: profile.name, fileName: f.rel, reason } });
    return { rejected: true };
  }

  const batch = await batchFor(profile, sub);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const s3Key = `${profile.ownerId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeKeyName(fileName)}`;
  await storage.putStream(s3Key, buf, type.mime);
  const file = await File.create({
    userId: profile.ownerId,
    batchId: batch ? batch._id : null,
    fileName,
    s3Key,
    mimeType: type.mime,
    sizeBytes: buf.length,
    source: 'scanner',
    status: 'processing',
    metadata: { capture: { device: profile.name, folder: sub || '', path: f.rel } },
  });
  await HotFolderImport.create({ ...key, status: 'imported', fileId: file._id, sha256: sha });
  await src.move(f, DONE_DIR).catch((e) => console.error(`hot folder ${profile.name}: could not move ${f.rel}:`, e.message));
  await emitAudit({
    userId: profile.ownerId,
    action: 'document.captured',
    documentId: file._id,
    details: { source: 'scanner', device: profile.name, folder: sub || '', fileName: f.rel, batchId: batch ? String(batch._id) : null },
  });
  require('../intake/pipeline').enqueueDocument(file._id);
  if (batch) events.emit('batch.touch', String(batch._id));
  return { imported: true, fileId: String(file._id) };
}

// files still being written by a scanner are left for the next poll
const pendingSizes = new Map(); // profile:path → size at the last poll

async function pollProfile(profile, now = Date.now()) {
  const src = sourceFor(profile);
  const files = await src.list();
  const result = { profile: profile.name, imported: 0, rejected: 0, waiting: 0, errors: [] };
  for (const f of files.slice(0, config.hotfolder.maxFilesPerPoll)) {
    const k = `${profile.name}:${f.rel}`;
    if (profile.kind === 'local') {
      const young = f.mtime && now - new Date(f.mtime).getTime() < config.hotfolder.stableSec * 1000;
      const changed = pendingSizes.has(k) && pendingSizes.get(k) !== f.size;
      if (young || changed) {
        pendingSizes.set(k, f.size);
        result.waiting++;
        continue;
      }
    }
    pendingSizes.delete(k);
    try {
      const r = await importOne(profile, src, f);
      if (r.imported) result.imported++;
      if (r.rejected) result.rejected++;
    } catch (e) {
      result.errors.push(`${f.rel}: ${e.message}`);
      console.error(`hot folder ${profile.name}: ${f.rel}:`, e.message);
    }
  }
  return result;
}

let running = null;
let lastRun = null;
/** Poll every enabled profile once (one run at a time). */
async function pollAll() {
  if (running) return running;
  running = (async () => {
    const out = [];
    for (const p of (await getProfiles()).filter((x) => x.enabled)) {
      try {
        out.push(await pollProfile(p));
      } catch (e) {
        out.push({ profile: p.name, imported: 0, rejected: 0, waiting: 0, errors: [e.message] });
      }
    }
    lastRun = { at: new Date(), results: out };
    return out;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

async function status(userId) {
  await requireAdmin(userId);
  return { profiles: await getProfiles(), root: config.hotfolder.root || null, intervalSec: config.hotfolder.intervalSec, enabled: config.hotfolder.enabled, lastRun };
}

async function recentImports(userId, limit = 50) {
  await requireAdmin(userId);
  return HotFolderImport.find({}).sort({ createdAt: -1 }).limit(Math.min(200, Number(limit) || 50)).lean();
}

async function pollNow(userId) {
  await requireAdmin(userId);
  return pollAll();
}

let timer = null;
function start() {
  if (timer || !config.hotfolder.enabled) return;
  timer = setInterval(() => pollAll().catch((e) => console.error('hot folders:', e.message)), config.hotfolder.intervalSec * 1000);
  timer.unref();
}
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { getProfiles, saveProfiles, pollAll, pollProfile, pollNow, status, recentImports, start, stop, HotFolderError, _pending: pendingSizes };
