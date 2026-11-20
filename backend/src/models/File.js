const mongoose = require('mongoose');

// An uploaded document. Textract output (raw text + detected tables) is stored
// once at upload time so every chat query reuses it without re-parsing.
const fileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // null = at the user's root; otherwise the file belongs to a Folder/set.
    folderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: null, index: true },
    fileName: { type: String, required: true },
    s3Key: { type: String, required: true },
    mimeType: { type: String, default: '' },
    // processing -> ready | failed
    // needs_review: processed, but a person must check it (OCR quality, duplicates,
    // classification — set by later stages)
    status: { type: String, enum: ['processing', 'ready', 'needs_review', 'failed'], default: 'processing' },
    rawText: { type: String, default: '' },
    tablesCsv: { type: String, default: '' },
    summary: { type: String, default: '' },
    keyFacts: { type: mongoose.Schema.Types.Mixed, default: [] },
    suggestedQuestions: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    // OCR word geometry (normalized bboxes) for on-image highlight overlays
    words: { type: Array, default: [] },
    error: { type: String, default: '' },

    // ----- Capture Hub fields (all optional; existing documents keep working) -----
    // Full extracted text lives in S3 when it exceeds config.text.maxStoredChars
    textLength: { type: Number, default: null },
    textTruncated: { type: Boolean, default: false },
    textS3Key: { type: String, default: null },
    sha256: { type: String, default: null, index: true },
    sizeBytes: { type: Number, default: null },
    pageCount: { type: Number, default: null },
    source: {
      type: String,
      enum: ['upload', 'camera', 'scanner', 'email', 'import'],
      default: 'upload',
    },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', default: null, index: true },
    batchItem: { type: Number, default: null }, // index into Batch.items
    // Standard HR metadata (P09) and AI suggestions (P10)
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    classification: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidentiality: { type: String, default: null },
    // Split / merge lineage (P11 / P12) — originals are never deleted
    parentDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    derivedFrom: [{ type: mongoose.Schema.Types.ObjectId, ref: 'File' }],

    // ----- Pipeline tracking -----
    stage: { type: String, default: null }, // current stage, or 'done'
    attempts: { type: Number, default: 0 }, // attempts on the current stage
    errorCode: { type: String, default: '' },
    stageHistory: [
      {
        _id: false,
        stage: String,
        status: { type: String, enum: ['done', 'failed'] },
        attempts: Number,
        startedAt: Date,
        finishedAt: Date,
        error: String,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('File', fileSchema);
