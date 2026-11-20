// Full-text indexing + partner hand-off.
//  indexDocument(id)  → (re)build the SearchDoc for a processed document (page offsets,
//                       language, metadata, access fields); removes it otherwise
//  syncToPartner(id)  → send ready documents to the partner HRDMS (payload schema
//                       docs/capture/partner-payload.schema.json); documents waiting for
//                       review are held back until a person accepts them
// Both run in the pipeline and again whenever 'document.changed' is emitted.
const config = require('../../core/config');
const events = require('../../core/events');
const { emitAudit } = require('../../core/audit');
const { getPartner } = require('../../providers/partner');
const File = require('../../models/File');
const SearchDoc = require('../../models/SearchDoc');
const OcrPage = require('../ocr/OcrPage.model');

const SCHEMA_VERSION = '1.0';
const SEARCHABLE = ['ready', 'needs_review'];

function normalizeText(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const STOP = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'for', 'with', 'on', 'that', 'this', 'are', 'be', 'employee'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'del', 'las', 'por', 'con', 'para', 'una', 'empleado'],
};
/** Rough language guess (English / Spanish) for stemming and the partner payload. */
function detectLanguage(text) {
  const words = (text.toLowerCase().match(/\p{L}+/gu) || []).slice(0, 4000);
  if (words.length < 5) return { lang: 'und', language: 'none' };
  const count = (list) => words.filter((w) => list.includes(w)).length;
  const en = count(STOP.en);
  const es = count(STOP.es);
  return es > en * 1.2 && es >= 5 ? { lang: 'es', language: 'spanish' } : { lang: 'en', language: 'english' };
}

/** Full text with page offsets (from OCR pages when available). */
async function textWithPages(file) {
  const max = config.text.maxStoredChars;
  const ocrPages = await OcrPage.find({ fileId: file._id }).select('page text').sort({ page: 1 }).lean();
  let text = '';
  const pages = [];
  if (ocrPages.length) {
    for (const p of ocrPages) {
      const t = normalizeText(p.text);
      if (text) text += '\n\n';
      const start = text.length;
      text += t;
      pages.push({ page: p.page, start, end: text.length });
    }
  } else {
    text = normalizeText(file.rawText);
    if (text) pages.push({ page: 1, start: 0, end: text.length });
  }
  const truncated = text.length > max || !!file.textTruncated;
  if (text.length > max) {
    text = text.slice(0, max);
    for (const p of pages) p.end = Math.min(p.end, max);
  }
  return { text, pages: pages.filter((p) => p.start < max), truncated };
}

async function indexDocument(fileId) {
  const file = await File.findById(fileId).lean();
  // superseded versions leave search; the current version replaces them
  if (!file || !SEARCHABLE.includes(file.status) || file.supersededBy || (file.splitInto && file.splitInto.length)) {
    await SearchDoc.deleteOne({ fileId });
    return null;
  }
  const { text, pages, truncated } = await textWithPages(file);
  const { lang, language } = detectLanguage(text);
  const md = file.metadata || {};
  const doc = {
    fileId: file._id,
    userId: file.userId,
    folderId: file.folderId || null,
    batchId: file.batchId || null,
    status: file.status,
    confidentiality: file.confidentiality || null,
    documentType: md.documentType || null,
    recordCategory: md.recordCategory || null,
    fileName: file.fileName,
    text,
    textTruncated: truncated,
    pages,
    lang,
    language,
    metadata: md,
    docCreatedAt: file.createdAt,
    indexedAt: new Date(),
  };
  return SearchDoc.findOneAndUpdate({ fileId: file._id }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
}

/** The partner payload (schema docs/capture/partner-payload.schema.json). */
function buildPayload(file, sd) {
  const ocr = file.ocr
    ? {
        provider: file.ocr.provider || null,
        averageConfidence: typeof file.ocr.avgConfidence === 'number' ? file.ocr.avgConfidence : null,
        formFields: (file.ocr.keyValues || []).map((kv) => ({ key: kv.key, value: kv.value || '', page: kv.page || null })),
      }
    : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    documentId: String(file._id),
    partnerDocumentId: (file.handoff && file.handoff.partnerDocumentId) || null,
    fileName: file.fileName,
    mimeType: file.mimeType || 'application/octet-stream',
    sizeBytes: file.sizeBytes || 0,
    sha256: file.sha256 || null,
    pageCount: file.pageCount || null,
    source: file.source || 'upload',
    capturedAt: new Date(file.createdAt).toISOString(),
    capturedBy: String(file.userId),
    folderId: file.folderId ? String(file.folderId) : null,
    batchId: file.batchId ? String(file.batchId) : null,
    parentDocumentId: file.parentDocumentId ? String(file.parentDocumentId) : null,
    supersedesDocumentId: file.supersedes ? String(file.supersedes) : null,
    confidentiality: file.confidentiality || null,
    metadata: file.metadata || {},
    files: {
      original: { s3Key: file.s3Key, contentType: file.mimeType || 'application/octet-stream' },
      searchablePdf: file.renditionS3Key ? { s3Key: file.renditionS3Key, contentType: 'application/pdf' } : null,
      fullText: file.textS3Key ? { s3Key: file.textS3Key, contentType: 'text/plain' } : null,
    },
    index: {
      language: sd ? sd.lang : 'und',
      text: sd ? sd.text : '',
      textTruncated: sd ? !!sd.textTruncated : false,
      pages: sd ? sd.pages.map((p) => ({ page: p.page, start: p.start, end: p.end })) : [],
    },
    ocr,
    review: file.reviewedAt
      ? {
          reviewedAt: new Date(file.reviewedAt).toISOString(),
          reviewedBy: file.reviewedBy ? String(file.reviewedBy) : null,
          resolvedReasons: (file.resolvedReviewReasons || []).map((r) => r.code),
        }
      : null,
  };
}

async function syncToPartner(fileId) {
  const file = await File.findById(fileId).lean();
  if (!file || file.status !== 'ready' || file.supersededBy) return null; // not ready, or an old version
  if (file.splitInto && file.splitInto.length) return null; // split: its parts are sent instead
  // the system of record needs the standard metadata: hold back until it is complete
  if (config.metadata.requiredForHandoff && file.metadataStatus !== 'complete') return null;
  const sd = await SearchDoc.findOne({ fileId: file._id }).lean();
  const payload = buildPayload(file, sd);
  const { partnerDocumentId } = await getPartner().pushDocument(file, payload);
  const first = !(file.handoff && file.handoff.partnerDocumentId);
  await File.updateOne(
    { _id: file._id },
    { handoff: { partnerDocumentId, schemaVersion: SCHEMA_VERSION, syncedAt: new Date() } }
  );
  await emitAudit({
    userId: file.userId,
    action: first ? 'document.handed_off' : 'document.resynced',
    documentId: file._id,
    details: { partnerDocumentId, schemaVersion: SCHEMA_VERSION },
  });
  return partnerDocumentId;
}

/** Remove a deleted document from the index. */
const removeFromIndex = (fileId) => SearchDoc.deleteOne({ fileId });

// Any change to a processed document → refresh its index entry and partner copy.
events.on('document.changed', async (fileId) => {
  const sd = await indexDocument(fileId);
  if (sd) await syncToPartner(fileId);
});

module.exports = { indexDocument, syncToPartner, removeFromIndex, buildPayload, normalizeText, detectLanguage, SCHEMA_VERSION };
