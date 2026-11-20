// Metadata entry (P09): the taxonomy (record categories → document types → fields),
// normalizing + validating values, saving with a per-field audit trail, bulk edits,
// and admin changes to the taxonomy (with JSON import/export).
const mongoose = require('mongoose');
const config = require('../../core/config');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { viewerFor, isRestricted } = require('../../core/access');
const { getPartner } = require('../../providers/partner');
const File = require('../../models/File');
const { RecordCategory, DocumentType } = require('./taxonomy.models');
const { BASE_FIELDS, PERSON_FIELDS, SYSTEM_KEYS, CONFIDENTIALITY, FIELD_TYPES } = require('./fields');
const seed = require('./seed-taxonomy.json');

class MetadataError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------- taxonomy
// Seed the RFP taxonomy into an empty database (checked on every use — a cheap count —
// so an emptied collection is re-seeded; concurrent callers share one run).
let seeding = null;
async function ensureSeeded() {
  if (seeding) return seeding;
  seeding = (async () => {
    if (await DocumentType.estimatedDocumentCount()) return;
    await RecordCategory.insertMany(seed.categories, { ordered: false }).catch(() => {});
    await DocumentType.insertMany(seed.documentTypes, { ordered: false }).catch(() => {});
  })().finally(() => {
    seeding = null;
  });
  return seeding;
}

async function getTaxonomy({ includeInactive = false } = {}) {
  await ensureSeeded();
  const [categories, documentTypes] = await Promise.all([
    RecordCategory.find().sort({ order: 1, name: 1 }).lean(),
    DocumentType.find(includeInactive ? {} : { active: true }).sort({ categoryKey: 1, order: 1, name: 1 }).lean(),
  ]);
  return {
    categories: categories.map(({ _id, __v, createdAt, updatedAt, ...c }) => c),
    documentTypes: documentTypes.map(({ _id, __v, createdAt, updatedAt, ...t }) => t),
    baseFields: BASE_FIELDS,
    personFields: PERSON_FIELDS,
    confidentialityLevels: CONFIDENTIALITY,
    fiscalYearStartMonth: config.metadata.fiscalYearStartMonth,
  };
}

/** Base fields with the document type's own fields merged in (type wins on the same key). */
function fieldsFor(type) {
  const merged = new Map(BASE_FIELDS.map((f) => [f.key, { ...f }]));
  for (const f of (type && type.fields) || []) merged.set(f.key, { ...(merged.get(f.key) || {}), ...f });
  return [...merged.values()];
}

// ---------------------------------------------------------------- values
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

function fiscalYearOf(dateStr) {
  if (!isDate(dateStr)) return null;
  const [y, m] = dateStr.split('-').map(Number);
  const start = config.metadata.fiscalYearStartMonth;
  return `FY${start === 1 ? y : m >= start ? y + 1 : y}`;
}

const clean = (v) => (v === undefined ? undefined : v === null ? '' : typeof v === 'string' ? v.trim().slice(0, 500) : v);

/**
 * Merge submitted values into the existing metadata: only known fields are accepted,
 * values are typed and checked, defaults come from the document type, the person is
 * verified with the partner, and the fiscal year is derived from the dates.
 * Returns { metadata, errors, type }.
 */
async function normalize(input, existing = {}) {
  await ensureSeeded();
  const out = { ...existing };
  const errors = [];
  const given = input || {};

  // document type first: it decides which fields exist
  if (given.documentType !== undefined) out.documentType = clean(given.documentType) || '';
  const type = out.documentType ? await DocumentType.findOne({ key: out.documentType }).lean() : null;
  if (out.documentType && (!type || !type.active)) errors.push({ field: 'documentType', message: 'Unknown document type' });
  const category = type ? await RecordCategory.findOne({ key: type.categoryKey }).lean() : null;
  const fields = fieldsFor(type);
  const allowed = new Map(fields.map((f) => [f.key, f]));

  // person: verified with the partner when picked from the directory; typed in otherwise
  if (given.personId !== undefined || PERSON_FIELDS.some((k) => given[k] !== undefined)) {
    for (const k of PERSON_FIELDS) delete out[k];
    if (given.personId) {
      const p = await getPartner().getPerson(String(given.personId));
      if (!p) errors.push({ field: 'person', message: 'That person was not found in the HR directory' });
      else
        Object.assign(out, {
          personId: p.personId,
          personType: p.type,
          employeeName: p.name,
          employeeId: p.employeeId || '',
          applicantNumber: p.applicantNumber || '',
          positionTitle: p.positionTitle || '',
          department: p.department || '',
          division: p.division || '',
        });
    } else {
      for (const k of PERSON_FIELDS.filter((x) => x !== 'personId')) if (given[k] !== undefined) out[k] = clean(given[k]);
    }
  }

  // every other field the type knows about
  for (const [key, raw] of Object.entries(given)) {
    if (key === 'documentType' || PERSON_FIELDS.includes(key) || SYSTEM_KEYS.includes(key)) continue;
    const f = allowed.get(key);
    if (!f || f.type === 'person' || f.type === 'doctype') continue; // unknown keys are ignored
    const v = clean(raw);
    if (v === '' || v === undefined) {
      delete out[key];
      continue;
    }
    if (f.type === 'date' && !isDate(String(v))) errors.push({ field: key, message: `${f.label}: use a valid date (YYYY-MM-DD)` });
    else if (f.type === 'number' && !Number.isFinite(Number(v))) errors.push({ field: key, message: `${f.label}: must be a number` });
    else if (f.type === 'select' && f.options && !f.options.includes(v)) errors.push({ field: key, message: `${f.label}: choose one of ${f.options.join(', ')}` });
    else if (f.type === 'fiscalyear' && !/^FY\d{4}$/.test(String(v))) errors.push({ field: key, message: `${f.label}: use the form FY2026` });
    else out[key] = f.type === 'number' ? Number(v) : v;
  }

  // defaults and derived values
  if (type) {
    out.recordCategory = category ? category.name : type.categoryKey;
    out.recordCategoryKey = type.categoryKey;
    if (!out.confidentialityLevel) out.confidentialityLevel = type.defaultConfidentiality || (category && category.defaultConfidentiality) || 'Confidential';
    if (!out.retentionCategory) out.retentionCategory = type.defaultRetentionCategory || (category && category.defaultRetentionCategory) || '';
    if (!out.hrFunctionalArea && category) out.hrFunctionalArea = category.hrFunctionalArea;
  }
  if (given.fiscalYear === undefined || given.fiscalYear === '' || given.fiscalYear === null) {
    const fy = fiscalYearOf(out.effectiveDate) || fiscalYearOf(out.creationDate);
    if (fy) out.fiscalYear = fy;
  }
  // drop fields that no longer apply after a type change (keep system keys + person)
  for (const k of Object.keys(out)) {
    if (!allowed.has(k) && !PERSON_FIELDS.includes(k) && !SYSTEM_KEYS.includes(k) && k !== 'documentType') delete out[k];
  }
  return { metadata: out, errors, type, fields };
}

/** Required-field check → list of { field, message }. */
function validate(md, fields) {
  const missing = [];
  for (const f of fields) {
    if (!f.required) continue;
    if (f.type === 'person') {
      if (!md.employeeId && !md.applicantNumber && !md.employeeName) missing.push({ field: 'person', message: 'Choose the employee or applicant' });
    } else if (md[f.key] === undefined || md[f.key] === '' || md[f.key] === null) {
      missing.push({ field: f.key, message: `${f.label} is required` });
    }
  }
  return missing;
}

const LEVEL_TO_CONFIDENTIALITY = { General: 'general', Confidential: 'confidential', Restricted: 'restricted' };
const CONFIDENTIALITY_TO_LEVEL = { general: 'General', confidential: 'Confidential', restricted: 'Restricted' };
const RANK = { general: 1, confidential: 2, restricted: 3 };

async function loadVisible(fileId, userId) {
  if (!mongoose.isValidObjectId(fileId)) throw new MetadataError(404, 'File not found');
  const viewer = await viewerFor(userId);
  if (!viewer) throw new MetadataError(400, 'A valid userId is required');
  const file = await File.findById(fileId);
  // restricted documents look like they don't exist to users without permission
  if (!file || (isRestricted(file.confidentiality) && !viewer.canSeeRestricted)) throw new MetadataError(404, 'File not found');
  return { file, viewer };
}

function diff(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const k of keys) {
    if (SYSTEM_KEYS.includes(k) && k !== 'recordCategory') continue;
    const a = before ? before[k] : undefined;
    const b = after ? after[k] : undefined;
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes.push({ field: k, from: a ?? null, to: b ?? null });
  }
  return changes;
}

async function applyMetadata(file, input, actorId, { auditAction = 'metadata.changed' } = {}) {
  const before = { ...(file.metadata || {}) };
  const { metadata, errors, fields } = await normalize(input, before);
  const missing = validate(metadata, fields);
  const allErrors = [...errors, ...missing];
  // a merged document never drops below its strictest source (P12)
  const floor = file.confidentialityFloor;
  if (floor && RANK[LEVEL_TO_CONFIDENTIALITY[metadata.confidentialityLevel]] < RANK[floor]) {
    metadata.confidentialityLevel = CONFIDENTIALITY_TO_LEVEL[floor];
  }
  const changes = diff(before, metadata);
  file.metadata = metadata;
  file.markModified('metadata');
  file.metadataErrors = allErrors;
  file.metadataStatus = allErrors.length ? (Object.keys(metadata).some((k) => !SYSTEM_KEYS.includes(k)) ? 'incomplete' : 'missing') : 'complete';
  const level = metadata.confidentialityLevel;
  if (level && LEVEL_TO_CONFIDENTIALITY[level]) file.confidentiality = LEVEL_TO_CONFIDENTIALITY[level];
  await file.save();
  if (changes.length) {
    await emitAudit({ userId: actorId, action: auditAction, documentId: file._id, details: { changes, status: file.metadataStatus } });
    events.emit('document.changed', String(file._id)); // re-index; hand off once complete
  }
  return { changes, errors: allErrors };
}

async function updateMetadata(fileId, { userId, metadata }) {
  const { file } = await loadVisible(fileId, userId);
  const { changes, errors } = await applyMetadata(file, metadata, userId);
  return { metadata: file.metadata, metadataStatus: file.metadataStatus, errors, changes };
}

/** Same values for many documents. preview=true shows what would change, saves nothing. */
async function bulkUpdate({ userId, fileIds, set, apply = false }) {
  if (!Array.isArray(fileIds) || !fileIds.length) throw new MetadataError(400, 'Choose at least one document');
  if (fileIds.length > 500) throw new MetadataError(400, 'At most 500 documents at a time');
  const results = [];
  for (const id of fileIds) {
    try {
      const { file } = await loadVisible(id, userId);
      if (!apply) {
        const { metadata, errors, fields } = await normalize(set, { ...(file.metadata || {}) });
        results.push({ fileId: String(file._id), fileName: file.fileName, changes: diff(file.metadata || {}, metadata), errors: [...errors, ...validate(metadata, fields)] });
      } else {
        const { changes, errors } = await applyMetadata(file, set, userId, { auditAction: 'metadata.bulk_changed' });
        results.push({ fileId: String(file._id), fileName: file.fileName, changes, errors, metadataStatus: file.metadataStatus });
      }
    } catch (e) {
      results.push({ fileId: String(id), error: e.message });
    }
  }
  return { applied: !!apply, results };
}

async function lookupPeople(q) {
  const query = String(q || '').trim();
  if (query.length < 2) return [];
  return (await getPartner().lookupPerson(query)).slice(0, 20);
}

/** Next document (after `afterId`) that still needs metadata — for "save & next". */
async function nextIncomplete(userId, afterId) {
  const viewer = await viewerFor(userId);
  if (!viewer) throw new MetadataError(400, 'A valid userId is required');
  const q = {
    userId,
    status: { $in: ['ready', 'needs_review'] },
    metadataStatus: { $ne: 'complete' },
    supersededBy: null,
    'splitInto.0': { $exists: false },
    ...(viewer.canSeeRestricted ? {} : { confidentiality: { $ne: 'restricted' } }),
  };
  if (afterId && mongoose.isValidObjectId(afterId)) q._id = { $ne: afterId };
  const next = await File.findOne(q).sort({ createdAt: 1 }).select('_id fileName').lean();
  return next ? { fileId: String(next._id), fileName: next.fileName } : null;
}

// ---------------------------------------------------------------- admin
async function requireAdmin(userId) {
  const viewer = await viewerFor(userId);
  if (!viewer || !viewer.isAdmin) throw new MetadataError(403, 'Only administrators can change the taxonomy');
  return viewer;
}

function checkType(t) {
  const problems = [];
  if (!t.key || !/^[a-z0-9.-]+$/.test(t.key)) problems.push('key: lowercase letters, numbers, dots and dashes');
  if (!t.name) problems.push('name is required');
  if (!t.categoryKey) problems.push('categoryKey is required');
  if (t.defaultConfidentiality && !CONFIDENTIALITY.includes(t.defaultConfidentiality)) problems.push(`defaultConfidentiality must be one of ${CONFIDENTIALITY.join(', ')}`);
  const seen = new Set();
  for (const f of t.fields || []) {
    if (!f.key || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(f.key)) problems.push(`field key "${f.key}" must be letters/numbers`);
    if (seen.has(f.key)) problems.push(`field "${f.key}" appears twice`);
    seen.add(f.key);
    if (!FIELD_TYPES.includes(f.type) || f.type === 'doctype') problems.push(`field "${f.key}": unknown type "${f.type}"`);
    if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length)) problems.push(`field "${f.key}": a pick-list needs options`);
    if (PERSON_FIELDS.includes(f.key) || f.key === 'documentType') problems.push(`field "${f.key}" is reserved`);
  }
  return problems;
}

async function saveDocumentType(userId, t) {
  await requireAdmin(userId);
  await ensureSeeded();
  const problems = checkType(t || {});
  if (problems.length) throw new MetadataError(400, 'This document type has problems', problems);
  if (!(await RecordCategory.exists({ key: t.categoryKey }))) throw new MetadataError(400, `Unknown category "${t.categoryKey}"`);
  const before = await DocumentType.findOne({ key: t.key }).lean();
  const doc = await DocumentType.findOneAndUpdate(
    { key: t.key },
    {
      key: t.key,
      name: t.name,
      categoryKey: t.categoryKey,
      defaultConfidentiality: t.defaultConfidentiality || 'Confidential',
      defaultRetentionCategory: t.defaultRetentionCategory || '',
      fields: t.fields || [],
      active: t.active !== false,
      order: Number(t.order) || 0,
    },
    { upsert: true, new: true }
  ).lean();
  await emitAudit({ userId, action: before ? 'taxonomy.type_updated' : 'taxonomy.type_created', details: { key: t.key, name: t.name } });
  return doc;
}

async function exportTaxonomy() {
  const t = await getTaxonomy({ includeInactive: true });
  return { version: 1, exportedAt: new Date().toISOString(), categories: t.categories, documentTypes: t.documentTypes };
}

async function importTaxonomy(userId, data, { mode = 'merge' } = {}) {
  await requireAdmin(userId);
  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.documentTypes))
    throw new MetadataError(400, 'Expected { categories: [...], documentTypes: [...] }');
  const problems = [];
  const catKeys = new Set(data.categories.map((c) => c.key));
  data.categories.forEach((c, i) => {
    if (!c.key || !c.name) problems.push(`categories[${i}]: key and name are required`);
  });
  data.documentTypes.forEach((t) => {
    const p = checkType(t);
    if (!catKeys.has(t.categoryKey)) p.push(`unknown category "${t.categoryKey}"`);
    if (p.length) problems.push(`${t.key || '(no key)'}: ${p.join('; ')}`);
  });
  if (problems.length) throw new MetadataError(400, 'The taxonomy file has problems', problems);
  await ensureSeeded();
  if (mode === 'replace') {
    // documents already filed keep their type key; replaced types are deactivated, not deleted
    await DocumentType.updateMany({ key: { $nin: data.documentTypes.map((t) => t.key) } }, { active: false });
  }
  for (const c of data.categories) await RecordCategory.findOneAndUpdate({ key: c.key }, c, { upsert: true });
  for (const t of data.documentTypes) await DocumentType.findOneAndUpdate({ key: t.key }, { ...t, active: t.active !== false }, { upsert: true });
  await emitAudit({ userId, action: 'taxonomy.imported', details: { mode, categories: data.categories.length, documentTypes: data.documentTypes.length } });
  return { categories: data.categories.length, documentTypes: data.documentTypes.length, mode };
}

module.exports = {
  MetadataError,
  ensureSeeded,
  getTaxonomy,
  fieldsFor,
  fiscalYearOf,
  normalize,
  validate,
  updateMetadata,
  applyMetadata,
  bulkUpdate,
  lookupPeople,
  nextIncomplete,
  saveDocumentType,
  exportTaxonomy,
  importTaxonomy,
};
