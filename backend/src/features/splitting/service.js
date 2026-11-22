// Document splitting (P11): one multi-document file → separate documents.
//   getPages()  — page list for the page view: words per page, blank pages, separators
//   suggest()   — AI-suggested cuts with a reason per cut
//   split()     — confirm a plan: parts (page ranges), rotations, removed pages
//   autoSplit() — pipeline: cut at separator sheets automatically
// The original is never changed or deleted: it stays linked to its parts (splitInto),
// leaves search and the partner hand-off, and each part runs the pipeline on its own.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { PDFDocument, degrees } = require('pdf-lib');
const config = require('../../core/config');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { viewerFor, canView } = require('../../core/access');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const Setting = require('../../models/Setting');
const OcrPage = require('../ocr/OcrPage.model');
const metadata = require('../metadata/service');
const { getSettings: getAiSettings, runClassification } = require('../classification/service');
const Batch = require('../../models/Batch');
const { pageSource, pageTexts, pageJpegs, loadPdf } = require('./pages');
const separators = require('./separators');
const { suggestSplits, SuggestFailed } = require('./suggest');

const MAX_PARTS = 200;

class SplitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isSplit = (f) => !!(f && f.splitInto && f.splitInto.length);

// ---------------------------------------------------------------- settings
const DEFAULTS = { separatorSheets: true, blankIsSeparator: false };
async function getSettings() {
  const s = await Setting.findOne({ key: 'splitting' }).lean();
  return { ...DEFAULTS, ...((s && s.value) || {}) };
}
async function saveSettings(userId, patch = {}) {
  const viewer = await viewerFor(userId);
  if (!viewer || !viewer.isAdmin) throw new SplitError(403, 'Only administrators can change splitting settings');
  const current = await getSettings();
  const next = { ...current };
  for (const k of Object.keys(DEFAULTS)) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  await Setting.findOneAndUpdate({ key: 'splitting' }, { value: next, updatedBy: userId }, { upsert: true });
  await emitAudit({ userId, action: 'settings.splitting_changed', details: { before: current, after: next } });
  return next;
}

// ---------------------------------------------------------------- pages
async function load(fileId, userId) {
  if (!mongoose.isValidObjectId(fileId)) throw new SplitError(404, 'File not found');
  const viewer = await viewerFor(userId);
  if (!viewer) throw new SplitError(400, 'A valid userId is required');
  const file = await File.findById(fileId);
  if (!canView(viewer, file)) throw new SplitError(404, 'File not found');
  return file;
}

/** Everything the page view and the splitter need about the pages. */
async function analyse(file, { original = null } = {}) {
  const src = await pageSource(file, original);
  const doc = await loadPdf(src.buffer);
  const pageCount = doc.getPageCount();
  const pages = await pageTexts(file, src.buffer, pageCount);
  const settings = await getSettings();
  const seps = settings.separatorSheets || settings.blankIsSeparator
    ? await separators.detect(pages, settings.separatorSheets ? pageJpegs(doc) : [], {
        blankIsSeparator: settings.blankIsSeparator,
        blankWords: config.ocr.blankPageWords,
      })
    : [];
  return { src, doc, pageCount, pages, separators: seps, settings };
}

async function getPages(fileId, userId) {
  const file = await load(fileId, userId);
  const a = await analyse(file);
  const sepBy = new Map(a.separators.map((s) => [s.page, s]));
  return {
    fileId: String(file._id),
    pageCount: a.pageCount,
    source: a.src.from,
    splittable: !isSplit(file) && !file.handoff && file.status !== 'processing',
    reason: isSplit(file) ? 'Already split' : file.handoff ? 'Already filed in the HR records system' : file.status === 'processing' ? 'Still processing' : null,
    pages: a.pages.map((p) => ({
      page: p.page,
      wordCount: p.wordCount,
      blank: p.wordCount < config.ocr.blankPageWords,
      snippet: p.text.replace(/\s+/g, ' ').trim().slice(0, 160),
      separator: sepBy.has(p.page) ? { via: sepBy.get(p.page).via, prefill: sepBy.get(p.page).prefill } : null,
    })),
    separatorParts: a.separators.length ? separators.partsFromSeparators(a.pageCount, a.separators) : [],
    suggestion: file.splitSuggestion || null,
    splitPending: hasSplitSuggestion(file),
    splitInto: file.splitInto || [],
    splitFrom: file.splitFrom || null,
  };
}

/** AI-suggested cuts. Saved on the document so the page view can show them again. */
async function suggest(fileId, userId) {
  const file = await load(fileId, userId);
  if (!(await getAiSettings()).aiEnabled) throw new SplitError(409, 'AI suggestions are turned off. Place the cuts by hand.');
  const a = await analyse(file);
  if (a.pageCount < 2) return { cuts: [], parts: [{ from: 1, to: 1, documentType: null, reason: 'Single page', confidence: 1 }] };
  // separator pages are never part of a document; tell the AI they are blank
  const sepPages = new Set(a.separators.map((s) => s.page));
  const pages = a.pages.map((p) => (sepPages.has(p.page) ? { ...p, text: '(separator sheet)' } : p));
  let r;
  try {
    r = await suggestSplits({ taxonomy: await metadata.getTaxonomy(), pages });
  } catch (e) {
    if (e instanceof SuggestFailed) throw new SplitError(502, `${e.message}. Place the cuts by hand.`);
    throw e;
  }
  const suggestion = { ...r, at: new Date() };
  await File.updateOne({ _id: file._id }, { splitSuggestion: suggestion });
  await emitAudit({ userId, action: 'split.suggested', documentId: file._id, details: { cuts: r.cuts.map((c) => c.page), model: r.model } });
  return suggestion;
}

// ---------------------------------------------------------------- split
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
const baseName = (n) => String(n || 'document').replace(/\.[^.]+$/, '');

/** Validate a plan against the page count; returns the normalised plan or throws. */
function validatePlan(plan, pageCount) {
  const removed = new Set((plan.removed || []).map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= pageCount));
  const rotations = {};
  for (const [k, v] of Object.entries(plan.rotations || {})) {
    const p = Number(k);
    const deg = ((Number(v) % 360) + 360) % 360;
    if (Number.isInteger(p) && p >= 1 && p <= pageCount && [90, 180, 270].includes(deg)) rotations[p] = deg;
  }
  const parts = Array.isArray(plan.parts) ? plan.parts : [];
  if (!parts.length) throw new SplitError(400, 'Add at least one part');
  if (parts.length > MAX_PARTS) throw new SplitError(400, `A file can be split into at most ${MAX_PARTS} parts`);
  const covered = new Set();
  const out = parts.map((p, i) => {
    const from = Number(p.from);
    const to = Number(p.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > pageCount || from > to)
      throw new SplitError(400, `Part ${i + 1} has an invalid page range`);
    const pages = [];
    for (let n = from; n <= to; n++) {
      if (covered.has(n)) throw new SplitError(400, `Page ${n} is in more than one part`);
      covered.add(n);
      if (!removed.has(n)) pages.push(n);
    }
    if (!pages.length) throw new SplitError(400, `Part ${i + 1} has no pages left`);
    return {
      from,
      to,
      pages,
      name: cleanName(p.name),
      documentType: p.documentType ? String(p.documentType) : null,
      employeeId: p.employeeId ? String(p.employeeId).slice(0, 40) : null,
      personId: p.personId ? String(p.personId).slice(0, 80) : null,
    };
  });
  // no page may disappear silently: every page is in a part or explicitly removed
  const lost = [];
  for (let n = 1; n <= pageCount; n++) if (!covered.has(n) && !removed.has(n)) lost.push(n);
  if (lost.length) throw new SplitError(400, `Page${lost.length > 1 ? 's' : ''} ${lost.join(', ')} ${lost.length > 1 ? 'are' : 'is'} not in any part — add ${lost.length > 1 ? 'them' : 'it'} to a part or remove ${lost.length > 1 ? 'them' : 'it'}`);
  return { parts: out, removed: [...removed].sort((a, b) => a - b), rotations };
}

/**
 * Create the parts. `parent` is a File document; `a` the analyse() result.
 * Children are created first, the parent is marked split, then the children start
 * processing (so their duplicate check never matches the original).
 */
async function applySplit(parent, a, plan, { actor = null, via = 'manual' } = {}) {
  const lock = crypto.randomBytes(6).toString('hex');
  const locked = await File.findOneAndUpdate({ _id: parent._id, 'splitInto.0': { $exists: false }, splitLock: null }, { splitLock: lock }, { new: true });
  if (!locked) throw new SplitError(409, 'This document has already been split');

  const tax = await metadata.getTaxonomy();
  const typeName = (k) => (tax.documentTypes.find((t) => t.key === k) || {}).name || null;
  const parentOcr = await OcrPage.find({ fileId: parent._id }).lean();
  const created = [];
  try {
    for (const [i, part] of plan.parts.entries()) {
      const out = await PDFDocument.create();
      const copied = await out.copyPages(a.doc, part.pages.map((n) => n - 1));
      copied.forEach((pg, j) => {
        const rot = plan.rotations[part.pages[j]];
        if (rot) pg.setRotation(degrees((pg.getRotation().angle + rot) % 360));
        out.addPage(pg);
      });
      // classic xref (no object streams): every PDF reader, incl. our text extractor, can read it
      const pdf = Buffer.from(await out.save({ useObjectStreams: false }));
      const nn = String(i + 1).padStart(2, '0');
      const key = `${parent.s3Key}.split/${lock}-${nn}.pdf`;
      await storage.putStream(key, pdf, 'application/pdf');
      const type = part.documentType && typeName(part.documentType) ? part.documentType : null;
      const name = `${cleanName(part.name).replace(/\.pdf$/i, '') || `${baseName(parent.fileName)} - part ${i + 1}${type ? ` (${typeName(type)})` : ''}`}.pdf`;
      const prefill = {};
      if (type) prefill.documentType = type;
      if (part.employeeId) prefill.employeeId = part.employeeId;
      if (part.personId) prefill.personId = part.personId;
      const child = await File.create({
        userId: parent.userId,
        folderId: parent.folderId,
        batchId: parent.batchId,
        fileName: name,
        s3Key: key,
        mimeType: 'application/pdf',
        sizeBytes: pdf.length,
        source: parent.source,
        status: 'processing',
        parentDocumentId: parent._id,
        derivedFrom: [parent._id],
        // protect parts of a restricted original until they are classified themselves
        confidentiality: parent.confidentiality || null,
        pageCount: part.pages.length,
        splitFrom: {
          fileId: parent._id,
          splitId: lock,
          part: i + 1,
          pages: part.pages,
          via,
          hasTextLayer: a.src.hasTextLayer,
          prefill,
          // digital pages: their text travels with the part (read once, from the original)
          ...(parentOcr.length ? {} : { pageTexts: part.pages.map((n) => a.pages[n - 1].text) }),
        },
      });
      created.push({ child, key });
      // OCR'd original: the part reuses the OCR of its pages (no second OCR run)
      const ocr = part.pages.map((n, j) => ({ n, j, p: parentOcr.find((o) => o.page === n) })).filter((x) => x.p);
      if (ocr.length) {
        await OcrPage.insertMany(
          ocr.map(({ j, p, n }) => ({
            fileId: child._id,
            page: j + 1,
            text: p.text,
            confidence: p.confidence,
            handwritingRatio: p.handwritingRatio,
            skewDegrees: p.skewDegrees,
            // word boxes no longer line up on a rotated page; the text stays
            words: plan.rotations[n] ? [] : p.words,
            keyValues: p.keyValues,
            tables: p.tables,
          }))
        );
      }
    }
  } catch (e) {
    for (const { child, key } of created) {
      await OcrPage.deleteMany({ fileId: child._id });
      await File.deleteOne({ _id: child._id });
      await storage.deleteObject(key).catch(() => {});
    }
    await File.updateOne({ _id: parent._id }, { splitLock: null });
    throw e;
  }

  const now = new Date();
  const open = parent.reviewReasons || [];
  const parentUpdate = {
    splitInto: created.map((c) => c.child._id),
    splitRemoved: plan.removed,
    splitAt: now,
    splitBy: actor,
    splitLock: null,
    reviewReasons: [],
    ...(open.length ? { $push: { resolvedReviewReasons: { $each: open.map((r) => ({ ...r, resolvedAt: now, resolvedBy: actor, resolution: 'split' })) } } } : {}),
    // a finished document stays usable (as the linked original); in the pipeline the
    // runner finishes it
    ...(['ready', 'needs_review'].includes(parent.status) ? { status: 'ready' } : {}),
  };
  await File.updateOne({ _id: parent._id }, parentUpdate);
  await emitAudit({
    userId: actor || parent.userId,
    action: 'document.split',
    documentId: parent._id,
    details: {
      via,
      splitId: lock,
      pageCount: a.pageCount,
      parts: created.map(({ child }, i) => ({ fileId: String(child._id), fileName: child.fileName, pages: plan.parts[i].pages })),
      removedPages: plan.removed,
      rotatedPages: Object.keys(plan.rotations).map(Number),
    },
  });
  // the original leaves search (its parts are indexed instead)
  require('../search/indexer').indexDocument(parent._id).catch(() => {});
  for (const { child } of created) require('../intake/pipeline').enqueueDocument(child._id);
  if (parent.batchId) events.emit('batch.touch', String(parent.batchId));
  events.emit('document.changed', String(parent._id));
  return { splitId: lock, parts: created.map(({ child }, i) => ({ fileId: String(child._id), fileName: child.fileName, pages: plan.parts[i].pages })) };
}

async function split(fileId, { userId, parts, removed, rotations, via } = {}) {
  const file = await load(fileId, userId);
  if (isSplit(file)) throw new SplitError(409, 'This document has already been split');
  if (file.handoff && file.handoff.partnerDocumentId) throw new SplitError(409, 'This document was already sent to the HR system and cannot be split here');
  if (!['ready', 'needs_review'].includes(file.status)) throw new SplitError(409, 'Wait until the document has finished processing');
  const a = await analyse(file);
  const plan = validatePlan({ parts, removed, rotations }, a.pageCount);
  return applySplit(file, a, plan, { actor: userId, via: ['manual', 'ai', 'separator'].includes(via) ? via : 'manual' });
}

/** Pipeline: cut at separator sheets. Returns true when the document was split. */
async function autoSplit(file, original) {
  if (file.splitFrom || isSplit(file)) return false;
  const settings = await getSettings();
  if (!settings.separatorSheets && !settings.blankIsSeparator) return false;
  let a;
  try {
    a = await analyse(file, { original });
  } catch (e) {
    if (e.code === 'NO_PAGES' || e.code === 'DAMAGED_FILE') return false;
    throw e;
  }
  if (a.pageCount < 2 || !a.separators.length) return false;
  const found = separators.partsFromSeparators(a.pageCount, a.separators);
  if (!found.length) return false;
  const plan = validatePlan(
    {
      parts: found.map((p) => ({ from: p.from, to: p.to, documentType: p.prefill.documentType, employeeId: p.prefill.employeeId })),
      removed: a.separators.map((s) => s.page),
    },
    a.pageCount
  );
  await applySplit(file, a, plan, { via: 'separator' });
  return true;
}

const SPLIT_STAGE = 'splitting';
const withoutSplitReasons = (reasons) => (reasons || []).filter((r) => r.stage !== SPLIT_STAGE);

/**
 * Pipeline, scan batches (P14): a stack scanned without separator sheets → the AI finds
 * where each document starts. splitMode "auto" applies the cuts; "suggest" (default) keeps
 * them for a person to check in the page view. Returns fields to save, 'split', or null.
 */
async function aiSplitForBatch(file, original) {
  if (!file.batchId || file.splitFrom || file.mergeOf || isSplit(file) || !(file.pageCount > 1)) return null;
  const batch = await Batch.findById(file.batchId).select('kind splitMode').lean();
  if (!batch || batch.kind !== 'scan' || batch.splitMode === 'separators') return null;
  if (!(await getAiSettings()).aiEnabled) return null;
  let a;
  try {
    a = await analyse(file, { original });
  } catch (e) {
    if (e.code === 'NO_PAGES' || e.code === 'DAMAGED_FILE') return null;
    throw e;
  }
  let r;
  try {
    r = await suggestSplits({ taxonomy: await metadata.getTaxonomy(), pages: a.pages });
  } catch (e) {
    if (e instanceof SuggestFailed) return null; // the stack stays one document; staff can split by hand
    throw e;
  }
  const suggestion = { ...r, at: new Date() };
  await emitAudit({ userId: file.userId, action: 'split.suggested', documentId: file._id, details: { cuts: r.cuts.map((c) => c.page), model: r.model, batchId: String(file.batchId) } });
  if (r.parts.length < 2) return { splitSuggestion: suggestion };
  if (batch.splitMode === 'auto') {
    await File.updateOne({ _id: file._id }, { splitSuggestion: suggestion });
    const plan = validatePlan({ parts: r.parts.map((p) => ({ from: p.from, to: p.to, documentType: p.documentType })) }, a.pageCount);
    await applySplit(file, a, plan, { via: 'ai' });
    return 'split';
  }
  return {
    splitSuggestion: suggestion,
    reviewReasons: [
      ...withoutSplitReasons(file.reviewReasons),
      { stage: SPLIT_STAGE, code: 'SPLIT_SUGGESTED', message: `This looks like ${r.parts.length} documents — check the suggested cuts in the page view` },
    ],
  };
}

const hasSplitSuggestion = (file) => (file.reviewReasons || []).some((r) => r.stage === SPLIT_STAGE);

/** The reviewer says the stack is really one document: drop the suggestion, classify it. */
async function keepWhole(fileId, userId) {
  const file = await load(fileId, userId);
  if (!hasSplitSuggestion(file)) throw new SplitError(409, 'There is no split suggestion to dismiss');
  const now = new Date();
  const open = (file.reviewReasons || []).filter((r) => r.stage === SPLIT_STAGE);
  file.reviewReasons = withoutSplitReasons(file.reviewReasons);
  file.resolvedReviewReasons = [...(file.resolvedReviewReasons || []), ...open.map((r) => ({ ...r, resolvedAt: now, resolvedBy: userId, resolution: 'kept_whole' }))];
  await file.save();
  await emitAudit({ userId, action: 'split.dismissed', documentId: file._id, details: { suggestedParts: (file.splitSuggestion && file.splitSuggestion.parts || []).length } });
  // the stack was never classified (it waited for the split decision): classify it now
  const upd = (await runClassification(await File.findById(file._id))) || {};
  const saved = await File.findByIdAndUpdate(file._id, upd, { new: true });
  const status = (saved.reviewReasons || []).length ? 'needs_review' : 'ready';
  await File.updateOne({ _id: file._id }, { status });
  events.emit('document.changed', String(file._id));
  if (file.batchId) events.emit('batch.touch', String(file.batchId));
  return { status, reviewReasons: saved.reviewReasons };
}

/** Links between a split original and its parts (light: no page analysis). */
async function lineage(fileId, userId) {
  const file = await load(fileId, userId);
  const viewer = await viewerFor(userId);
  const visible = (f) => canView(viewer, f);
  const parts = isSplit(file)
    ? (await File.find({ _id: { $in: file.splitInto } }).select('fileName status confidentiality splitFrom').lean())
        .sort((a, b) => a.splitFrom.part - b.splitFrom.part)
        .map((f) => (visible(f) ? { fileId: String(f._id), fileName: f.fileName, status: f.status, pages: f.splitFrom.pages } : { restricted: true, pages: f.splitFrom.pages }))
    : [];
  let from = null;
  if (file.splitFrom) {
    const o = await File.findById(file.splitFrom.fileId).select('fileName confidentiality').lean();
    if (o) from = visible(o) ? { fileId: String(o._id), fileName: o.fileName, part: file.splitFrom.part, pages: file.splitFrom.pages } : { restricted: true, part: file.splitFrom.part, pages: file.splitFrom.pages };
  }
  return { splitInto: parts, splitAt: file.splitAt, splitFrom: from };
}

/** The PDF whose pages the page view shows (thumbnails). */
async function pagesPdf(fileId, userId) {
  const file = await load(fileId, userId);
  return (await pageSource(file)).buffer;
}

module.exports = { aiSplitForBatch, keepWhole, hasSplitSuggestion, lineage, getPages, suggest, split, autoSplit, pagesPdf, getSettings, saveSettings, validatePlan, isSplit, SplitError };
