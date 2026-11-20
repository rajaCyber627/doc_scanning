const express = require('express');
const router = express.Router();
const multer = require('multer');
const config = require('../../core/config');
const File = require('../../models/File');
const Folder = require('../../models/Folder');
const TableResult = require('../tables/TableResult.model');
const Chunk = require('../query/Chunk.model');
const { s3, BUCKET } = require('../../providers/storage/client');
const { enqueueDocument } = require('../intake/pipeline');
const { emitAudit } = require('../../core/audit');
const { removeDocument } = require('./removeDocument');
const OcrPage = require('../ocr/OcrPage.model');
const events = require('../../core/events');

// In-memory upload; the buffer goes straight to S3 (no local disk needed).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ===========================================================================
// Files
// ===========================================================================
// Upload -> store in S3 -> respond immediately -> parse with Textract in background
// Legacy (pre-P02) form upload. New clients use /api/uploads (direct-to-S3).
const legacyGuard = (req, res, next) =>
  config.upload.legacyRoute
    ? next()
    : res.status(410).json({ message: 'This upload method is disabled. Use /api/uploads.' });
router.post('/api/files', legacyGuard, upload.array('files', 20), async (req, res) => {
  try {
    const { userId } = req.body;
    const uploaded = req.files || [];
    if (!uploaded.length) return res.status(400).json({ message: 'No file provided' });
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    // Attach to an existing folder if given; otherwise a single multi-file
    // request becomes its own new folder/set (a single file stays at root).
    let folderId = req.body.folderId || null;
    if (!folderId && uploaded.length > 1) {
      const name =
        (req.body.folderName && String(req.body.folderName).trim()) ||
        `Set · ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`;
      const folder = await Folder.create({ userId, name });
      folderId = folder._id;
    }

    const created = [];
    for (const f of uploaded) {
      const prefix = folderId ? `${userId}/${folderId}/` : `${userId}/`;
      const rand = Math.random().toString(36).slice(2, 7);
      const s3Key = `${prefix}${Date.now()}-${rand}-${f.originalname}`;
      await s3
        .upload({ Bucket: BUCKET, Key: s3Key, Body: f.buffer, ContentType: f.mimetype })
        .promise();
      const fileDoc = await File.create({
        userId,
        folderId,
        fileName: f.originalname,
        s3Key,
        mimeType: f.mimetype,
        status: 'processing',
        source: 'upload',
        sizeBytes: f.size,
      });
      created.push({ fileId: fileDoc._id, fileName: f.originalname, status: 'processing' });
      await emitAudit({
        userId,
        action: 'document.uploaded',
        documentId: fileDoc._id,
        details: { fileName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size, folderId },
      });
      // Queue for processing; pass the buffer so pdf/docx/text avoid a re-download.
      enqueueDocument(fileDoc._id, { buffer: f.buffer });
    }

    res.status(201).json({ folderId, files: created });
  } catch (err) {
    console.error('upload error:', err && err.message);
    res.status(500).json({ message: 'Upload failed' });
  }
});

// List a user's files (light — no raw text / tables blob)
router.get('/api/files', async (req, res) => {
  try {
    const { userId } = req.query;
    // Superseded versions (replaced duplicates) are hidden unless asked for.
    const q = userId ? { userId } : {};
    if (req.query.includeSuperseded !== '1') q.supersededBy = null;
    const files = await File.find(q)
      .select('-rawText -tablesCsv -words')
      .sort({ createdAt: -1 });
    res.json(files);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// File details + presigned view URL + its saved tables
router.get('/api/files/:id', async (req, res) => {
  try {
    const file = await File.findById(req.params.id).select('-rawText -tablesCsv -words');
    if (!file) return res.status(404).json({ message: 'File not found' });
    const sign = (Key, extra = {}) => s3.getSignedUrl('getObject', { Bucket: BUCKET, Key, Expires: 3600, ...extra });
    // viewUrl: what the browser displays (converted JPEG for HEIC/GIF/BMP);
    // downloadUrl: always the untouched original.
    const viewUrl = sign(file.ocrSourceS3Key || file.s3Key);
    const downloadUrl = sign(file.s3Key, {
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(file.fileName || 'file')}"`,
    });
    const [tables, children, parent] = await Promise.all([
      TableResult.find({ fileId: file._id }).sort({ createdAt: -1 }),
      File.find({ parentDocumentId: file._id }).select('fileName status stage error mimeType createdAt').sort({ s3Key: 1 }).lean(),
      file.parentDocumentId ? File.findById(file.parentDocumentId).select('fileName status').lean() : null,
    ]);
    res.json({ file, viewUrl, downloadUrl, tables, children, parent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Rename a file and/or update its tags
router.patch('/api/files/:id', async (req, res) => {
  try {
    const { fileName, tags } = req.body;
    const update = {};
    if (typeof fileName === 'string' && fileName.trim()) update.fileName = fileName.trim();
    if (Array.isArray(tags)) update.tags = tags.map((t) => String(t).trim()).filter(Boolean);
    const before = await File.findById(req.params.id).select('fileName tags userId').lean();
    if (!before) return res.status(404).json({ message: 'File not found' });
    const file = await File.findByIdAndUpdate(req.params.id, update, { new: true }).select(
      '-rawText -tablesCsv'
    );
    if (!file) return res.status(404).json({ message: 'File not found' });
    const changes = {};
    if (update.fileName && update.fileName !== before.fileName)
      changes.fileName = { from: before.fileName, to: update.fileName };
    if (update.tags && JSON.stringify(update.tags) !== JSON.stringify(before.tags || []))
      changes.tags = { from: before.tags || [], to: update.tags };
    if (Object.keys(changes).length) {
      await emitAudit({
        userId: req.body.userId || before.userId,
        action: 'document.updated',
        documentId: file._id,
        details: changes,
      });
      events.emit('document.changed', String(file._id));
    }
    res.json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Search a document's extracted text (works for PDF/DOCX/images via rawText)
router.get('/api/files/:id/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ matches: [], count: 0, truncated: false });
    const file = await File.findById(req.params.id).select('rawText');
    if (!file) return res.status(404).json({ message: 'File not found' });
    const lines = (file.rawText || '').split('\n');
    const needle = q.toLowerCase();
    const LIMIT = 200;
    const matches = [];
    for (let i = 0; i < lines.length && matches.length < LIMIT; i++) {
      const line = lines[i];
      const idx = line.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 50);
      const end = Math.min(line.length, idx + needle.length + 80);
      const snippet =
        (start > 0 ? '…' : '') + line.slice(start, end).trim() + (end < line.length ? '…' : '');
      matches.push({ line: i + 1, text: snippet });
    }
    res.json({ matches, count: matches.length, truncated: matches.length >= LIMIT });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// A document's full extracted text (for the in-viewer find/text view)
router.get('/api/files/:id/text', async (req, res) => {
  try {
    const file = await File.findById(req.params.id).select('rawText');
    if (!file) return res.status(404).json({ message: 'File not found' });
    res.json({ text: file.rawText || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// OCR word geometry (normalized bboxes) for on-image highlight overlays
router.get('/api/files/:id/geometry', async (req, res) => {
  try {
    const file = await File.findById(req.params.id).select('words');
    if (!file) return res.status(404).json({ message: 'File not found' });
    // Per-page OCR results (P06); optional ?page=N. Older documents kept words on the File.
    const q = { fileId: file._id };
    if (req.query.page) q.page = Number(req.query.page);
    const pages = await OcrPage.find(q).select('page words').sort({ page: 1 }).lean();
    if (!pages.length) return res.json({ words: file.words || [] });
    const words = pages.flatMap((p) => p.words.map((w) => ({ text: w.t, page: p.page, x: w.x, y: w.y, w: w.w, h: w.h, confidence: w.c })));
    res.json({ words });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Stream the raw file bytes same-origin (so pdf.js can fetch a PDF without
// hitting S3 CORS). Used by the in-page PDF viewer.
// Best available preview of any document: its PDF view, a converted image, or the
// original when browsers can show it (PDF / PNG / JPEG). Used by the compare view.
router.get('/api/files/:id/preview', async (req, res) => {
  try {
    const file = await File.findById(req.params.id).select('s3Key mimeType fileName renditionS3Key ocrSourceS3Key');
    if (!file) return res.status(404).json({ message: 'File not found' });
    let key = null;
    let type = null;
    if (file.renditionS3Key) [key, type] = [file.renditionS3Key, 'application/pdf'];
    else if (file.ocrSourceS3Key) [key, type] = [file.ocrSourceS3Key, 'image/jpeg'];
    else if (/^(application\/pdf|image\/(png|jpeg))$/.test(file.mimeType || '')) [key, type] = [file.s3Key, file.mimeType];
    if (!key) return res.status(404).json({ message: 'No preview for this document' });
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    const stream = s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
    stream.on('error', () => !res.headersSent && res.status(500).end());
    stream.pipe(res);
  } catch (err) {
    console.error('preview error:', err && err.message);
    res.status(500).json({ message: 'Could not load the preview' });
  }
});

// The PDF view (rendition) of a non-PDF document, streamed same-origin for pdf.js.
router.get('/api/files/:id/rendition', async (req, res) => {
  try {
    const file = await File.findById(req.params.id).select('renditionS3Key fileName');
    if (!file) return res.status(404).json({ message: 'File not found' });
    if (!file.renditionS3Key) return res.status(404).json({ message: 'No preview for this document yet' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent((file.fileName || 'file') + '.pdf')}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    const stream = s3.getObject({ Bucket: BUCKET, Key: file.renditionS3Key }).createReadStream();
    stream.on('error', (e) => {
      console.error('rendition stream error:', e && e.message);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('rendition error:', err && err.message);
    res.status(500).json({ message: 'Could not load the preview' });
  }
});

router.get('/api/files/:id/raw', async (req, res) => {
  try {
    const file = await File.findById(req.params.id).select('s3Key mimeType fileName');
    if (!file) return res.status(404).json({ message: 'File not found' });
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName || 'file')}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    const stream = s3.getObject({ Bucket: BUCKET, Key: file.s3Key }).createReadStream();
    stream.on('error', (e) => {
      console.error('raw stream error:', e && e.message);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  } catch (err) {
    console.error('raw error:', err && err.message);
    res.status(500).json({ message: 'Could not load file' });
  }
});

// Delete a file (+ its tables + S3 object)
router.delete('/api/files/:id', async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (file) {
      await removeDocument(file);
      await emitAudit({
        userId: req.query.userId || file.userId,
        action: 'document.deleted',
        documentId: file._id,
        details: { fileName: file.fileName, sha256: file.sha256 || null },
      });
    }
    res.json({ message: 'File deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
