// Automated / assisted classification (P10).
//  runClassification(file) — "classify" pipeline stage: AI suggests type, person,
//    confidentiality and details with confidence + quoted evidence. Possibly-restricted
//    documents are protected immediately (before any person sees them) and go to the
//    restricted queue. Nothing is filed until a reviewer accepts (unless an admin turns
//    on auto-accept for very confident suggestions).
//  decide()   — accept (optionally with edits) or reassign between queues
//  queue()    — the general / restricted review queues
//  accuracy() — how often reviewers keep the AI's suggestions, per document type
const mongoose = require('mongoose');
const events = require('../../core/events');
const config = require('../../core/config');
const { emitAudit } = require('../../core/audit');
const { viewerFor, isRestricted } = require('../../core/access');
const { getPartner } = require('../../providers/partner');
const File = require('../../models/File');
const Setting = require('../../models/Setting');
const OcrPage = require('../ocr/OcrPage.model');
const metadata = require('../metadata/service');
const { BASE_FIELDS } = require('../metadata/fields');
const ClassificationOutcome = require('./ClassificationOutcome.model');
const { classify, ClassificationFailed } = require('./classifier');

const STAGE = 'classification';

class ClassificationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- settings
const RESTRICTED_FIRST_BELOW = 0.6; // confidentiality confidence under this → restricted queue
const DEFAULTS = () => ({ aiEnabled: config.classification.aiEnabledByDefault, autoAccept: false, autoAcceptThreshold: 0.95, typeThresholds: {} });

async function getSettings() {
  const s = await Setting.findOne({ key: 'classification' }).lean();
  return { ...DEFAULTS(), ...((s && s.value) || {}) };
}

async function saveSettings(userId, patch) {
  const viewer = await viewerFor(userId);
  if (!viewer || !viewer.isAdmin) throw new ClassificationError(403, 'Only administrators can change AI settings');
  const current = await getSettings();
  const next = { ...current };
  if (typeof patch.aiEnabled === 'boolean') next.aiEnabled = patch.aiEnabled;
  if (typeof patch.autoAccept === 'boolean') next.autoAccept = patch.autoAccept;
  if (patch.autoAcceptThreshold !== undefined) {
    const t = Number(patch.autoAcceptThreshold);
    if (!(t >= 0.5 && t <= 1)) throw new ClassificationError(400, 'The auto-accept threshold must be between 0.5 and 1');
    next.autoAcceptThreshold = t;
  }
  if (patch.typeThresholds && typeof patch.typeThresholds === 'object') {
    next.typeThresholds = {};
    for (const [k, v] of Object.entries(patch.typeThresholds)) if (Number(v) >= 0.5 && Number(v) <= 1) next.typeThresholds[k] = Number(v);
  }
  await Setting.findOneAndUpdate({ key: 'classification' }, { value: next, updatedBy: userId }, { upsert: true });
  await emitAudit({ userId, action: 'settings.classification_changed', details: { before: current, after: next } });
  return next;
}

// ---------------------------------------------------------------- classify
function fieldGuide(tax) {
  const seen = new Map();
  for (const f of [...BASE_FIELDS, ...tax.documentTypes.flatMap((t) => t.fields || [])]) {
    if (f.type === 'person' || f.type === 'doctype' || f.key === 'confidentialityLevel' || seen.has(f.key)) continue;
    seen.set(f.key, `- ${f.key}: ${f.label} (${f.type}${f.options ? `: ${f.options.join(' / ')}` : ''})`);
  }
  return [...seen.values()].join('\n');
}

// "Patel, Priya" / "PRIYA  PATEL" / "Priya R. Patel" all count as the same name
const nameTokens = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 1);
function sameName(a, b) {
  const [x, y] = [nameTokens(a), nameTokens(b)];
  if (!x.length || !y.length) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((t) => long.includes(t));
}

/** Find the suggested person in the HR directory: exact ID > unique exact name. */
async function matchPerson(p) {
  const partner = getPartner();
  const norm = (s) => String(s || '').trim().toLowerCase();
  for (const [field, val] of [['employeeId', p.employeeId], ['applicantNumber', p.applicantNumber]]) {
    if (!val) continue;
    const hits = (await partner.lookupPerson(String(val))).filter((x) => norm(x[field]) === norm(val));
    if (hits.length === 1) {
      const m = { kind: 'id', personId: hits[0].personId, name: hits[0].name, employeeId: hits[0].employeeId, applicantNumber: hits[0].applicantNumber };
      // the document names someone else than the directory has for this ID: a person must check
      if (p.name && !sameName(p.name, hits[0].name)) Object.assign(m, { nameMismatch: true, nameOnDocument: p.name });
      return m;
    }
  }
  if (p.name) {
    const hits = (await partner.lookupPerson(p.name)).filter((x) => norm(x.name) === norm(p.name));
    if (hits.length === 1) return { kind: 'name', personId: hits[0].personId, name: hits[0].name, employeeId: hits[0].employeeId, applicantNumber: hits[0].applicantNumber };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.length };
  }
  return { kind: 'none' };
}

/** Person named on a separator sheet / chosen when splitting. */
async function matchPrefill(prefill) {
  if (prefill.personId) {
    const p = await getPartner().getPerson(prefill.personId);
    if (p) return { kind: 'id', personId: p.personId, name: p.name, employeeId: p.employeeId, applicantNumber: p.applicantNumber };
  }
  return prefill.employeeId ? matchPerson({ employeeId: prefill.employeeId }) : { kind: 'none' };
}

/** A suggestion from separator-sheet details alone (AI off, or no text to read). */
function fromPrefill(prefill, tax) {
  const type = prefill.documentType && tax.documentTypes.find((t) => t.key === prefill.documentType);
  return {
    model: 'separator-sheet',
    truncated: false,
    answer: {
      documentType: type ? type.key : null,
      confidentialityLevel: (type && type.defaultConfidentiality) || 'Confidential',
      restrictedLikely: false,
      person: { name: null, employeeId: prefill.employeeId || null, applicantNumber: null, quote: null, page: null },
      fields: [],
      // without a type we cannot judge confidentiality → restricted-first
      confidence: { documentType: type ? 1 : 0, person: 0, confidentiality: type ? 1 : 0 },
    },
  };
}

/** Metadata form input built from a suggestion. */
function suggestionToInput(s) {
  const input = { documentType: s.documentType || '', confidentialityLevel: s.confidentialityLevel };
  if (s.person && s.person.match && s.person.match.personId) input.personId = s.person.match.personId;
  else if (s.person && (s.person.name || s.person.employeeId || s.person.applicantNumber)) {
    input.employeeName = s.person.name || '';
    input.employeeId = s.person.employeeId || '';
    input.applicantNumber = s.person.applicantNumber || '';
  }
  for (const f of s.fields || []) input[f.key] = f.value;
  return input;
}

function withoutStage(reasons) {
  return (reasons || []).filter((r) => r.stage !== STAGE);
}

/** The "classify" pipeline stage. Returns the fields to save on the document. */
async function runClassification(file) {
  const settings = await getSettings();
  // Details printed on a separator sheet (or chosen when splitting) are trusted hints.
  const prefill = (file.splitFrom && file.splitFrom.prefill) || {};
  const hasPrefill = !!(prefill.documentType || prefill.employeeId || prefill.personId);
  if (!settings.aiEnabled && !hasPrefill) return { classification: { status: 'disabled', at: new Date() } };
  const pages = await OcrPage.find({ fileId: file._id }).select('page text').sort({ page: 1 }).lean();
  const hasText = pages.length > 0 || !!String(file.rawText || '').trim();
  if (!hasText && !hasPrefill) return { classification: { status: 'skipped', reason: 'no text', at: new Date() } };

  const tax = await metadata.getTaxonomy();
  let result;
  try {
    result = settings.aiEnabled && hasText ? await classify({ taxonomy: tax, fieldGuide: fieldGuide(tax), pages, rawText: file.rawText }) : fromPrefill(prefill, tax);
  } catch (e) {
    if (!(e instanceof ClassificationFailed)) throw e;
    await emitAudit({ userId: file.userId, action: 'classification.failed', documentId: file._id, details: { error: e.message } });
    return {
      classification: { status: 'failed', error: e.message, at: new Date() },
      reviewReasons: [...withoutStage(file.reviewReasons), { stage: STAGE, code: 'CLASSIFICATION_FAILED', message: `${e.message} — enter the details by hand` }],
    };
  }

  const { answer, model, truncated } = result;
  let type = answer.documentType ? tax.documentTypes.find((t) => t.key === answer.documentType) : null;
  const preType = prefill.documentType && tax.documentTypes.find((t) => t.key === prefill.documentType);
  if (preType) {
    type = preType;
    answer.confidence.documentType = 1;
  }
  const allowed = new Set(metadata.fieldsFor(type).filter((f) => !['person', 'doctype'].includes(f.type) && f.key !== 'confidentialityLevel').map((f) => f.key));
  const fields = answer.fields.filter((f) => allowed.has(f.key) && String(f.value).trim()).slice(0, 40);
  let match = await matchPerson(answer.person);
  if (prefill.personId || prefill.employeeId) {
    const pre = await matchPrefill(prefill);
    if (pre.kind === 'id') {
      match = pre;
      answer.confidence.person = 1;
    }
  }
  // Restricted-first: when the AI is unsure about confidentiality, protect the record.
  const unsureConfidentiality = !(answer.confidence.confidentiality >= RESTRICTED_FIRST_BELOW);
  if (match.nameMismatch) answer.confidence.person = Math.min(answer.confidence.person, 0.5);
  const restricted = answer.restrictedLikely || answer.confidentialityLevel === 'Restricted' || (type && type.defaultConfidentiality === 'Restricted') || unsureConfidentiality;
  const suggestion = {
    documentType: type ? type.key : null,
    documentTypeName: type ? type.name : null,
    confidentialityLevel: restricted ? 'Restricted' : answer.confidentialityLevel,
    person: { name: answer.person.name, employeeId: answer.person.employeeId, applicantNumber: answer.person.applicantNumber, quote: answer.person.quote, page: answer.person.page, match },
    fields,
  };
  const confidence = { ...answer.confidence, documentType: type ? answer.confidence.documentType : 0 };
  const classification = {
    status: 'suggested',
    queue: restricted ? 'restricted' : 'general',
    model,
    at: new Date(),
    textTruncated: truncated,
    restrictedLikely: !!answer.restrictedLikely,
    suggestion,
    confidence,
  };
  await emitAudit({
    userId: file.userId,
    action: 'classification.suggested',
    documentId: file._id,
    details: { documentType: suggestion.documentType, confidentialityLevel: suggestion.confidentialityLevel, confidence, personMatch: match.kind, fields: fields.map((f) => f.key), model },
  });

  // Auto-accept only very confident suggestions with an exact person match (admin opt-in).
  const threshold = (type && settings.typeThresholds[type.key]) || settings.autoAcceptThreshold;
  const confident = type && match.kind === 'id' && !match.nameMismatch && Math.min(confidence.documentType, confidence.person, confidence.confidentiality) >= threshold;
  if (settings.autoAccept && confident && !restricted) {
    const doc = await File.findById(file._id);
    const { errors } = await metadata.applyMetadata(doc, suggestionToInput(suggestion), null, { auditAction: 'metadata.auto_filled' });
    if (!errors.length) {
      await ClassificationOutcome.create({ fileId: file._id, model, suggestedType: suggestion.documentType, finalType: suggestion.documentType, typeCorrect: true, fields: [] });
      return { classification: { ...classification, status: 'auto_accepted' }, reviewReasons: withoutStage(file.reviewReasons) };
    }
  }

  const pct = Math.round(confidence.documentType * 100);
  return {
    classification,
    // protect the record now: never lower an existing confidentiality
    ...(restricted ? { confidentiality: 'restricted' } : {}),
    reviewReasons: [
      ...withoutStage(file.reviewReasons),
      {
        stage: STAGE,
        code: restricted ? 'CLASSIFICATION_REVIEW_RESTRICTED' : 'CLASSIFICATION_REVIEW',
        message: type ? `Check the suggested details: ${type.name} (${pct}% sure)` : 'The AI could not tell the document type — choose it by hand',
      },
    ],
  };
}

// ---------------------------------------------------------------- review
async function loadForReview(fileId, userId) {
  if (!mongoose.isValidObjectId(fileId)) throw new ClassificationError(404, 'File not found');
  const viewer = await viewerFor(userId);
  if (!viewer) throw new ClassificationError(400, 'A valid userId is required');
  const file = await File.findById(fileId);
  if (!file || (isRestricted(file.confidentiality) && !viewer.canSeeRestricted)) throw new ClassificationError(404, 'File not found');
  return { file, viewer };
}

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

async function accept(fileId, { userId, metadata: edits = {} }) {
  const { file } = await loadForReview(fileId, userId);
  const c = file.classification || {};
  if (c.status !== 'suggested' && c.status !== 'failed') throw new ClassificationError(409, 'There is no suggestion waiting for review');
  const suggestion = c.suggestion || { fields: [] };
  const input = { ...(c.status === 'suggested' ? suggestionToInput(suggestion) : {}), ...edits };
  const { errors } = await metadata.applyMetadata(file, input, userId);
  const md = file.metadata || {};

  // accuracy record: suggested vs kept, per field
  if (c.status === 'suggested') {
    const fieldsCmp = [
      { field: 'documentType', suggested: suggestion.documentType, final: md.documentType },
      { field: 'confidentialityLevel', suggested: suggestion.confidentialityLevel, final: md.confidentialityLevel },
      { field: 'person', suggested: suggestion.person?.match?.personId || suggestion.person?.employeeId || suggestion.person?.name, final: md.personId || md.employeeId || md.employeeName },
      ...(suggestion.fields || []).map((f) => ({ field: f.key, suggested: f.value, final: md[f.key] })),
    ].map((x) => ({ ...x, accepted: same(x.suggested, x.final) }));
    await ClassificationOutcome.create({
      fileId: file._id,
      userId,
      model: c.model,
      suggestedType: suggestion.documentType,
      finalType: md.documentType || null,
      typeCorrect: same(suggestion.documentType, md.documentType),
      fields: fieldsCmp,
    });
  }

  const open = (file.reviewReasons || []).filter((r) => r.stage === STAGE);
  file.resolvedReviewReasons.push(...open.map((r) => ({ ...r, resolvedAt: new Date(), resolvedBy: userId, decision: 'accepted' })));
  file.reviewReasons = withoutStage(file.reviewReasons);
  file.classification = { ...c, status: 'accepted', acceptedBy: userId, acceptedAt: new Date() };
  file.markModified('classification');
  if (file.status === 'needs_review' && !file.reviewReasons.length) file.status = 'ready';
  await file.save();
  await emitAudit({
    userId,
    action: 'classification.accepted',
    documentId: file._id,
    details: { suggested: suggestion.documentType, final: md.documentType, edited: Object.keys(edits) },
  });
  events.emit('document.changed', String(file._id));
  if (file.batchId) events.emit('batch.touch', String(file.batchId));
  return { status: file.status, metadataStatus: file.metadataStatus, errors };
}

async function reassign(fileId, { userId, queue }) {
  if (!['general', 'restricted'].includes(queue)) throw new ClassificationError(400, 'queue must be general or restricted');
  const { file, viewer } = await loadForReview(fileId, userId);
  if (queue === 'general' && !viewer.canSeeRestricted) throw new ClassificationError(403, 'Only staff with restricted access can release a document to the general queue');
  const c = file.classification || {};
  file.classification = { ...c, queue };
  file.markModified('classification');
  file.confidentiality = queue === 'restricted' ? 'restricted' : 'confidential';
  file.reviewReasons = file.reviewReasons.map((r) =>
    r.stage === STAGE ? { ...r, code: queue === 'restricted' ? 'CLASSIFICATION_REVIEW_RESTRICTED' : 'CLASSIFICATION_REVIEW' } : r
  );
  await file.save();
  await emitAudit({ userId, action: 'classification.reassigned', documentId: file._id, details: { queue } });
  events.emit('document.changed', String(file._id));
  return { queue };
}

async function queue(userId, name = 'general') {
  const viewer = await viewerFor(userId);
  if (!viewer) throw new ClassificationError(400, 'A valid userId is required');
  if (name === 'restricted' && !viewer.canSeeRestricted) throw new ClassificationError(403, 'You do not have access to the restricted queue');
  const q = {
    status: 'needs_review',
    'reviewReasons.stage': STAGE,
    supersededBy: null,
    confidentiality: name === 'restricted' ? 'restricted' : { $ne: 'restricted' },
  };
  const docs = await File.find(q).select('fileName createdAt classification reviewReasons batchId').sort({ createdAt: 1 }).limit(500).lean();
  return docs.map((d) => ({
    fileId: String(d._id),
    fileName: d.fileName,
    uploadedAt: d.createdAt,
    batchId: d.batchId ? String(d.batchId) : null,
    documentTypeName: d.classification?.suggestion?.documentTypeName || null,
    confidence: d.classification?.confidence?.documentType ?? null,
    person: d.classification?.suggestion?.person?.match?.name || d.classification?.suggestion?.person?.name || null,
    reasons: d.reviewReasons.map((r) => r.message),
  }));
}

async function accuracy(userId) {
  const viewer = await viewerFor(userId);
  if (!viewer || !viewer.isAdmin) throw new ClassificationError(403, 'Only administrators can see accuracy reports');
  const rows = await ClassificationOutcome.aggregate([
    { $unwind: { path: '$fields', preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: { type: '$finalType', file: '$fileId', typeCorrect: '$typeCorrect' },
        fieldsTotal: { $sum: { $cond: [{ $ifNull: ['$fields', false] }, 1, 0] } },
        fieldsAccepted: { $sum: { $cond: ['$fields.accepted', 1, 0] } },
      },
    },
    {
      $group: {
        _id: '$_id.type',
        documents: { $sum: 1 },
        typeCorrect: { $sum: { $cond: ['$_id.typeCorrect', 1, 0] } },
        fieldsTotal: { $sum: '$fieldsTotal' },
        fieldsAccepted: { $sum: '$fieldsAccepted' },
      },
    },
    { $sort: { documents: -1 } },
  ]);
  return rows.map((r) => ({
    documentType: r._id,
    documents: r.documents,
    typeAcceptance: r.documents ? Math.round((r.typeCorrect / r.documents) * 100) / 100 : null,
    fieldAcceptance: r.fieldsTotal ? Math.round((r.fieldsAccepted / r.fieldsTotal) * 100) / 100 : null,
  }));
}

module.exports = { runClassification, accept, reassign, queue, accuracy, getSettings, saveSettings, suggestionToInput, ClassificationError, STAGE };
