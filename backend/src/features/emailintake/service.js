// Email capture (P15): documents e-mailed to the HR intake mailbox reach the system without
// anyone downloading them. Each new message is checked (allowed sender, verified, not seen
// before), stored as an email document — the existing email handling (P05) then makes the
// body and every attachment linked documents — and moved to Processed (or Rejected).
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
const EmailIntakeLog = require('./EmailIntakeLog.model');
const { parseEml, parseMsg } = require('../documents/formats/email');
const { getEmailSource } = require('./sources');
const { extractHints } = require('./hints');

class EmailIntakeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- settings
const DEFAULTS = { enabled: true, allowList: [], ownerId: null, ownerEmail: '', importBody: 'auto', minBodyChars: 80 };
async function getSettings() {
  const s = await Setting.findOne({ key: 'emailintake' }).lean();
  return { ...DEFAULTS, ...((s && s.value) || {}) };
}

const ENTRY_RE = /^(@?[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/i;
async function saveSettings(userId, patch = {}) {
  const v = await viewerFor(userId);
  if (!v || !v.isAdmin) throw new EmailIntakeError(403, 'Only administrators can change email intake');
  const cur = await getSettings();
  const next = { ...cur };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.allowList !== undefined) {
    const list = (Array.isArray(patch.allowList) ? patch.allowList : String(patch.allowList).split(/[\s,;]+/))
      .map((x) => String(x).trim().toLowerCase())
      .filter(Boolean);
    const bad = list.filter((x) => !ENTRY_RE.test(x));
    if (bad.length) throw new EmailIntakeError(400, `Not an address or domain: ${bad.slice(0, 3).join(', ')}`);
    next.allowList = [...new Set(list.map((x) => x.replace(/^@/, '')))].slice(0, 500);
  }
  if (patch.ownerEmail !== undefined) {
    const owner = await User.findOne({ email: String(patch.ownerEmail).trim().toLowerCase() }).select('_id email').lean();
    if (!owner) throw new EmailIntakeError(400, 'Choose the staff member who owns e-mailed documents (their email)');
    next.ownerId = String(owner._id);
    next.ownerEmail = owner.email;
  }
  if (['auto', 'always', 'never'].includes(patch.importBody)) next.importBody = patch.importBody;
  if (patch.minBodyChars !== undefined) {
    const n = Number(patch.minBodyChars);
    if (!(n >= 0 && n <= 5000)) throw new EmailIntakeError(400, 'Minimum body length must be between 0 and 5000 characters');
    next.minBodyChars = n;
  }
  await Setting.findOneAndUpdate({ key: 'emailintake' }, { value: next, updatedBy: userId }, { upsert: true });
  await emitAudit({ userId, action: 'settings.emailintake_changed', details: { allowList: next.allowList.length, owner: next.ownerEmail, importBody: next.importBody, enabled: next.enabled } });
  return next;
}

// ---------------------------------------------------------------- checks
const addressOf = (from) => {
  const m = /<([^>]+)>/.exec(String(from || ''));
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
};
function senderAllowed(address, allowList) {
  if (!address || !address.includes('@')) return false;
  const domain = address.split('@').pop();
  return allowList.some((e) => (e.includes('@') ? e === address : domain === e || domain.endsWith(`.${e}`)));
}
/** Exchange / receiving servers stamp SPF/DKIM/DMARC results; a DMARC fail means a forged sender. */
const dmarcFailed = (authResults) => /\bdmarc=fail\b/i.test(String(authResults || ''));

/** Is the body worth filing on its own (more than a greeting, signature or "see attached")? */
function meaningfulBody(text, min) {
  const lines = String(text || '').split('\n');
  const kept = [];
  for (const l of lines) {
    const t = l.trim();
    if (/^--\s*$/.test(t) || /^(sent from my|get outlook for)/i.test(t) || /^-{2,}\s*(original|forwarded) message/i.test(t) || /^on .+ wrote:$/i.test(t)) break;
    if (t.startsWith('>')) continue;
    kept.push(t);
  }
  const body = kept.join(' ').replace(/\s+/g, ' ').trim();
  const words = body.split(' ').filter((w) => /[a-z]{2,}/i.test(w)).length;
  return body.length >= min && words >= 12;
}

const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

async function dailyBatch(ownerId, label) {
  const day = new Date().toISOString().slice(0, 10);
  const name = `Email · ${label} · ${day}`;
  const existing = await Batch.findOne({ name, createdBy: ownerId, source: 'email', status: { $ne: 'completed' } });
  return existing || Batch.create({ name, source: 'email', createdBy: ownerId, items: [] });
}

// ---------------------------------------------------------------- one message
async function processMessage(src, item, settings) {
  const base = { source: src.kind, sourceId: item.id };
  const { raw, format } = await src.fetch(item.id);
  let parsed;
  try {
    parsed = format === 'msg' ? await parseMsg(raw) : await parseEml(raw);
  } catch (e) {
    await src.markRejected(item.id);
    await EmailIntakeLog.create({ ...base, status: 'rejected', reason: 'The message could not be read' });
    return 'rejected';
  }
  const h = parsed.email || {};
  const from = addressOf(h.from);
  const messageId = h.messageId || item.messageId || `sha256:${sha(raw)}`;
  const subjectHash = sha(h.subject).slice(0, 16);
  const ids = { from, subjectHash, messageId };

  // same message again (re-sent, or moved back into the inbox) → not stored twice
  const seen = await EmailIntakeLog.findOne({ messageId, status: 'imported' }).select('fileId').lean();
  if (seen) {
    await src.markProcessed(item.id);
    await EmailIntakeLog.create({ ...base, ...ids, status: 'duplicate', reason: 'This message was already imported', fileId: seen.fileId });
    await emitAudit({ userId: settings.ownerId, action: 'email.duplicate', documentId: seen.fileId, details: ids });
    return 'duplicate';
  }

  let reason = null;
  if (!settings.allowList.length) reason = 'No senders are allowed yet (email intake allow-list is empty)';
  else if (!senderAllowed(from, settings.allowList)) reason = 'Sender is not on the allow-list';
  else if (dmarcFailed(parsed.authResults)) reason = 'The sender could not be verified (DMARC failed)';
  if (reason) {
    await src.markRejected(item.id);
    await EmailIntakeLog.create({ ...base, ...ids, status: 'rejected', reason });
    await emitAudit({ userId: settings.ownerId, action: 'email.rejected', details: { ...ids, reason } });
    return 'rejected';
  }

  const body = String(parsed.text || '').split('\n\n').slice(1).join('\n\n'); // text after the header block
  const containerOnly = settings.importBody === 'never' || (settings.importBody === 'auto' && !meaningfulBody(body, settings.minBodyChars));
  const hints = extractHints(h.subject, body);
  const batch = await dailyBatch(settings.ownerId, src.label.split(/[\\/]/).pop());
  const ext = format === 'msg' ? 'msg' : 'eml';
  const fileName = `${safeName(h.subject) || 'Email'}.${ext}`;
  const s3Key = `${settings.ownerId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-email.${ext}`;
  await storage.putStream(s3Key, raw, ext === 'msg' ? 'application/vnd.ms-outlook' : 'message/rfc822');
  const file = await File.create({
    userId: settings.ownerId,
    batchId: batch._id,
    fileName,
    s3Key,
    mimeType: ext === 'msg' ? 'application/vnd.ms-outlook' : 'message/rfc822',
    sizeBytes: raw.length,
    source: 'email',
    status: 'processing',
    containerOnly,
    ...(hints.restricted ? { confidentiality: 'restricted' } : {}),
    metadata: { emailIntake: { messageId, mailbox: src.label, receivedAt: item.receivedAt || null }, intakeHints: hints },
  });
  await src.markProcessed(item.id);
  await EmailIntakeLog.create({ ...base, ...ids, status: 'imported', fileId: file._id, attachments: (parsed.children || []).length });
  await emitAudit({ userId: settings.ownerId, action: 'email.imported', documentId: file._id, details: { ...ids, attachments: (parsed.children || []).length, bodyFiled: !containerOnly } });
  require('../intake/pipeline').enqueueDocument(file._id);
  events.emit('batch.touch', String(batch._id));
  return 'imported';
}

// ---------------------------------------------------------------- polling
let running = null;
let lastRun = null;
async function pollOnce() {
  if (running) return running;
  running = (async () => {
    const result = { imported: 0, rejected: 0, duplicate: 0, failed: 0, errors: [] };
    const settings = await getSettings();
    let src;
    try {
      src = getEmailSource();
    } catch (e) {
      result.errors.push(e.message);
    }
    if (!src) {
      if (!result.errors.length) result.errors.push('Email intake is not configured on this server (EMAIL_INTAKE_SOURCE)');
    } else if (!settings.enabled) result.errors.push('Email intake is switched off');
    else if (!settings.ownerId) result.errors.push('Choose who owns e-mailed documents first');
    else {
      let items = [];
      try {
        items = await src.list(config.emailIntake.maxPerPoll);
      } catch (e) {
        result.errors.push(e.message);
      }
      for (const it of items) {
        try {
          result[await processMessage(src, it, settings)]++;
        } catch (e) {
          // network / storage trouble: the message stays in the inbox for the next poll
          result.failed++;
          result.errors.push(`${it.id}: ${e.message}`);
          console.error('email intake:', e.message);
        }
      }
    }
    lastRun = { at: new Date(), ...result };
    return result;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

async function requireAdmin(userId) {
  const v = await viewerFor(userId);
  if (!v || !v.isAdmin) throw new EmailIntakeError(403, 'Only administrators can manage email intake');
}
async function status(userId) {
  await requireAdmin(userId);
  let label = null;
  try {
    label = getEmailSource() && getEmailSource().label;
  } catch {
    label = null;
  }
  return { source: config.emailIntake.source || null, mailbox: label, pollSec: config.emailIntake.pollSec, settings: await getSettings(), lastRun };
}
async function recentLog(userId, limit = 50) {
  await requireAdmin(userId);
  return EmailIntakeLog.find({}).sort({ createdAt: -1 }).limit(Math.min(200, Number(limit) || 50)).lean();
}
async function pollNow(userId) {
  await requireAdmin(userId);
  return pollOnce();
}

let timer = null;
function start() {
  if (timer || !config.emailIntake.source) return;
  timer = setInterval(() => pollOnce().catch((e) => console.error('email intake:', e.message)), config.emailIntake.pollSec * 1000);
  timer.unref();
}

module.exports = { getSettings, saveSettings, pollOnce, pollNow, status, recentLog, start, senderAllowed, meaningfulBody, EmailIntakeError };
