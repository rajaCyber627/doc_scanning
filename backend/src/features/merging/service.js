// Document merging (P12): pages from 2+ documents → one new PDF document.
//   preview() — the sources, their pages, the details they agree / disagree on
//   merge()   — build the document in the chosen page order (rotate / leave out pages)
// Sources are never changed or deleted: they are linked (derivedFrom) and, if asked,
// marked superseded (hidden from lists and search, kept for the record).
// The result is never less confidential than its strictest source.
const mongoose = require('mongoose');
const { PDFDocument, degrees } = require('pdf-lib');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { viewerFor, isRestricted } = require('../../core/access');
const storage = require('../../providers/storage');
const File = require('../../models/File');
const OcrPage = require('../ocr/OcrPage.model');
const metadata = require('../metadata/service');
const { pageSource, pageTexts, loadPdf } = require('../splitting/pages');

const MAX_PAGES = 500;
const MAX_SOURCES = 50;
const RANK = { general: 1, confidential: 2, restricted: 3 };

class MergeError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// PDF views carry the OCR text; a digital PDF has its own; a scan / image does not
const pageHasTextLayer = (s, page) => s.hasTextLayer || (!s.ocr.length && s.texts[page - 1].wordCount > 0);

const strictest = (levels) => levels.reduce((best, l) => ((RANK[l] || 0) > (RANK[best] || 0) ? l : best), null);

async function loadSources(fileIds, userId) {
  const viewer = await viewerFor(userId);
  if (!viewer) throw new MergeError(400, 'A valid userId is required');
  const ids = [...new Set((fileIds || []).map(String))];
  if (ids.length < 2) throw new MergeError(400, 'Choose at least two documents to merge');
  if (ids.length > MAX_SOURCES) throw new MergeError(400, `At most ${MAX_SOURCES} documents can be merged at once`);
  if (!ids.every((id) => mongoose.isValidObjectId(id))) throw new MergeError(404, 'File not found');
  const files = await File.find({ _id: { $in: ids } });
  const byId = new Map(files.map((f) => [String(f._id), f]));
  return ids.map((id) => {
    const f = byId.get(id);
    if (!f || (isRestricted(f.confidentiality) && !viewer.canSeeRestricted)) throw new MergeError(404, 'File not found');
    if (!['ready', 'needs_review'].includes(f.status)) throw new MergeError(409, `"${f.fileName}" has not finished processing`);
    if (f.supersededBy) throw new MergeError(409, `"${f.fileName}" has been replaced by a newer version`);
    if (f.splitInto && f.splitInto.length) throw new MergeError(409, `"${f.fileName}" was split — merge its parts instead`);
    return f;
  });
}

/** Where the sources disagree. Each conflict lists the distinct values and which files have them. */
async function conflictsOf(sources) {
  const tax = await metadata.getTaxonomy();
  const group = (key, label) => {
    const m = new Map();
    for (const f of sources) {
      const v = key(f);
      if (!v) continue;
      if (!m.has(v.value)) m.set(v.value, { value: v.value, label: v.label, fileIds: [] });
      m.get(v.value).fileIds.push(String(f._id));
    }
    return { field: label, values: [...m.values()] };
  };
  const md = (f) => f.metadata || {};
  const person = group((f) => {
    const x = md(f);
    if (x.personId) return { value: `id:${x.personId}`, label: `${x.employeeName || x.personId}${x.employeeId ? ` (${x.employeeId})` : ''}` };
    if (x.employeeId) return { value: `emp:${x.employeeId}`, label: `${x.employeeName || 'Employee'} (${x.employeeId})` };
    return null;
  }, 'person');
  const type = group((f) => {
    const k = md(f).documentType;
    return k ? { value: k, label: (tax.documentTypes.find((t) => t.key === k) || {}).name || k } : null;
  }, 'documentType');
  const levels = sources.map((f) => f.confidentiality || 'confidential');
  const level = strictest(levels);
  return {
    conflicts: [person, type].filter((g) => g.values.length > 1),
    agreed: {
      person: person.values.length === 1 ? person.values[0] : null,
      documentType: type.values.length === 1 ? type.values[0] : null,
    },
    confidentiality: level,
    mixedRestricted: levels.some((l) => l === 'restricted') && levels.some((l) => l !== 'restricted'),
  };
}

async function preview({ userId, fileIds } = {}) {
  const sources = await loadSources(fileIds, userId);
  const info = await conflictsOf(sources);
  return {
    sources: sources.map((f) => ({
      fileId: String(f._id),
      fileName: f.fileName,
      pageCount: f.pageCount || null,
      confidentiality: f.confidentiality || null,
      documentType: (f.metadata || {}).documentType || null,
      employeeName: (f.metadata || {}).employeeName || null,
    })),
    ...info,
  };
}

/** Resolve the person / type for the merged document (pre-fill for review). */
function resolve(info, resolution = {}) {
  const prefill = {};
  const missing = [];
  for (const c of info.conflicts) {
    const chosen = resolution[c.field];
    if (chosen === undefined) missing.push(c);
    else if (chosen && !c.values.some((v) => v.value === chosen)) throw new MergeError(400, `That ${c.field === 'person' ? 'person' : 'document type'} is not one of the choices`);
  }
  if (missing.length) {
    throw new MergeError(409, `The documents disagree on the ${missing.map((c) => (c.field === 'person' ? 'person' : 'document type')).join(' and ')} — choose one`, { conflicts: missing });
  }
  const person = resolution.person !== undefined ? resolution.person : info.agreed.person && info.agreed.person.value;
  const type = resolution.documentType !== undefined ? resolution.documentType : info.agreed.documentType && info.agreed.documentType.value;
  if (person && person.startsWith('id:')) prefill.personId = person.slice(3);
  if (person && person.startsWith('emp:')) prefill.employeeId = person.slice(4);
  if (type) prefill.documentType = type;
  return prefill;
}

/**
 * @param body.pages [{ fileId, page, rotate? }] in the new order (pages left out are just not listed)
 * @param body.resolution { person?, documentType? } choices for conflicts ('' = leave to review)
 * @param body.acknowledgeRestricted true once the user accepted that the result is restricted
 * @param body.supersede mark the sources as replaced by the merged document
 */
async function merge(body = {}) {
  const { userId, pages = [], name, resolution, acknowledgeRestricted, supersede } = body;
  if (!Array.isArray(pages) || pages.length < 2) throw new MergeError(400, 'A merged document needs at least two pages');
  if (pages.length > MAX_PAGES) throw new MergeError(400, `A merged document can have at most ${MAX_PAGES} pages`);
  const sources = await loadSources(pages.map((p) => p && p.fileId), userId);
  const info = await conflictsOf(sources);
  if (info.mixedRestricted && !acknowledgeRestricted) {
    throw new MergeError(409, 'Some pages are restricted (medical, leave, ADA, investigations…). The merged document will be restricted too — confirm to continue.', { needsAcknowledgement: 'restricted' });
  }
  const prefill = resolve(info, resolution);

  // load each source's pages once
  const src = new Map();
  for (const f of sources) {
    const s = await pageSource(f);
    const doc = await loadPdf(s.buffer);
    const count = doc.getPageCount();
    src.set(String(f._id), {
      file: f,
      doc,
      count,
      hasTextLayer: s.hasTextLayer,
      texts: await pageTexts(f, s.buffer, count),
      ocr: await OcrPage.find({ fileId: f._id }).lean(),
    });
  }
  const order = pages.map((p, i) => {
    const s = src.get(String(p.fileId));
    const page = Number(p.page);
    if (!Number.isInteger(page) || page < 1 || page > s.count) throw new MergeError(400, `Page ${p.page} of "${s.file.fileName}" does not exist`);
    const rotate = ((Number(p.rotate) || 0) % 360 + 360) % 360;
    if (![0, 90, 180, 270].includes(rotate)) throw new MergeError(400, `Item ${i + 1}: rotate by 90, 180 or 270 degrees`);
    return { fileId: String(p.fileId), page, rotate };
  });
  const seen = new Set();
  for (const p of order) {
    const k = `${p.fileId}:${p.page}`;
    if (seen.has(k)) throw new MergeError(400, 'A page can only be used once');
    seen.add(k);
  }
  if (new Set(order.map((p) => p.fileId)).size < 2) throw new MergeError(400, 'Choose pages from at least two documents');

  const out = await PDFDocument.create();
  for (const p of order) {
    const s = src.get(p.fileId);
    const [pg] = await out.copyPages(s.doc, [p.page - 1]);
    if (p.rotate) pg.setRotation(degrees((pg.getRotation().angle + p.rotate) % 360));
    out.addPage(pg);
  }
  const pdf = Buffer.from(await out.save({ useObjectStreams: false }));

  const first = sources[0];
  const key = `uploads/${userId}/merged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  await storage.putStream(key, pdf, 'application/pdf');
  const level = info.confidentiality;
  const baseName = (n) => String(n || 'document').replace(/\.[^.]+$/, '');
  const fileName = `${String(name || '').replace(/[\u0000-\u001f/\\]+/g, ' ').trim().replace(/\.pdf$/i, '').slice(0, 200) || `${baseName(first.fileName)} (merged)`}.pdf`;
  const merged = await File.create({
    userId,
    folderId: first.folderId,
    fileName,
    s3Key: key,
    mimeType: 'application/pdf',
    sizeBytes: pdf.length,
    source: 'upload',
    status: 'processing',
    pageCount: order.length,
    derivedFrom: sources.map((f) => f._id),
    confidentiality: level,
    confidentialityFloor: level,
    mergeOf: {
      sources: sources.map((f) => f._id),
      pages: order,
      // the text of every page travels with it: nothing is read or OCR'd again
      pageTexts: order.map((p) => src.get(p.fileId).texts[p.page - 1].text),
      hasTextLayer: order.every((p) => pageHasTextLayer(src.get(p.fileId), p.page)),
      prefill,
    },
  });
  // OCR word boxes, remapped to the new page numbers (find-in-document highlights)
  const ocrRows = [];
  order.forEach((p, i) => {
    const o = src.get(p.fileId).ocr.find((x) => x.page === p.page);
    if (!o) return;
    ocrRows.push({
      fileId: merged._id,
      page: i + 1,
      text: o.text,
      confidence: o.confidence,
      handwritingRatio: o.handwritingRatio,
      skewDegrees: o.skewDegrees,
      words: p.rotate ? [] : o.words, // boxes no longer line up on a rotated page
      keyValues: o.keyValues,
      tables: o.tables,
    });
  });
  if (ocrRows.length) await OcrPage.insertMany(ocrRows);

  if (supersede) {
    const now = new Date();
    await File.updateMany({ _id: { $in: sources.map((f) => f._id) }, supersededBy: null }, { supersededBy: merged._id, supersededAt: now });
    for (const f of sources) {
      await emitAudit({ userId, action: 'document.superseded', documentId: f._id, details: { supersededBy: String(merged._id), reason: 'merged' } });
      require('../search/indexer').indexDocument(f._id).catch(() => {});
    }
  }
  await emitAudit({
    userId,
    action: 'document.merged',
    documentId: merged._id,
    details: {
      sources: sources.map((f) => String(f._id)),
      pages: order.map((p) => ({ fileId: p.fileId, page: p.page, ...(p.rotate ? { rotate: p.rotate } : {}) })),
      confidentiality: level,
      supersede: !!supersede,
      ...(info.conflicts.length ? { resolved: Object.fromEntries(info.conflicts.map((c) => [c.field, (resolution || {})[c.field] || null])) } : {}),
    },
  });
  require('../intake/pipeline').enqueueDocument(merged._id);
  events.emit('document.changed', String(merged._id));
  return { fileId: String(merged._id), fileName, pageCount: order.length, confidentiality: level };
}

module.exports = { preview, merge, MergeError, conflictsOf };
