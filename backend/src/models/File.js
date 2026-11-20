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
    // OCR summary (P06): provider, pages, average confidence, form fields (key → value)
    ocr: { type: mongoose.Schema.Types.Mixed, default: null },
    // Why a person must check this document (OCR quality, duplicates, classification…).
    // Any open reason makes the finished document "needs_review" instead of "ready".
    reviewReasons: { type: Array, default: [] }, // [{ code, message, stage, page? }]
    resolvedReviewReasons: { type: Array, default: [] }, // history: reason + resolvedAt/By
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Partner hand-off (P07): set once the partner HRDMS has accepted the document
    handoff: { type: mongoose.Schema.Types.Mixed, default: null }, // { partnerDocumentId, schemaVersion, syncedAt }
    // Viewing: PDF rendition for formats browsers can't show (P05); converted JPEG for
    // HEIC/GIF/BMP (also what OCR reads). Originals are never modified.
    renditionS3Key: { type: String, default: null },
    renditionMethod: { type: String, default: null }, // libreoffice | text | image
    ocrSourceS3Key: { type: String, default: null },
    // Containers (emails, archives): how many child documents were created / skipped
    containerDepth: { type: Number, default: 0 },
    childSummary: {
      created: { type: Number, default: 0 },
      skipped: { type: Array, default: [] }, // [{ name, reason }]
    },
    // Full extracted text lives in S3 when it exceeds config.text.maxStoredChars
    textLength: { type: Number, default: null },
    textTruncated: { type: Boolean, default: false },
    textS3Key: { type: String, default: null },
    sha256: { type: String, default: null, index: true },
    // Duplicate detection (P08): text fingerprints, what this duplicates, the decision
    contentHash: { type: String, default: null, index: true },
    minhash: { type: [Number], default: [] },
    lshBands: { type: [String], default: [], index: true },
    numberTokens: { type: [String], default: [] },
    duplicateOf: { type: Array, default: [] }, // [{ kind, where, fileId?, similarity, restricted, sameBatch }]
    duplicateDecision: { type: mongoose.Schema.Types.Mixed, default: null }, // { action, reason, by, at }
    // Versions: "Replace existing" keeps the old document, marked as superseded
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null, index: true },
    supersededAt: { type: Date, default: null },
    supersedes: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    sizeBytes: { type: Number, default: null },
    pageCount: { type: Number, default: null },
    source: {
      type: String,
      enum: ['upload', 'camera', 'scanner', 'email', 'import'],
      default: 'upload',
    },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', default: null, index: true },
    batchItem: { type: Number, default: null }, // index into Batch.items
    // Standard HR metadata (P09) and AI suggestions (P10). metadataStatus: missing |
    // incomplete | complete (required fields valid → may be handed to the partner)
    metadataStatus: { type: String, enum: ['missing', 'incomplete', 'complete'], default: 'missing', index: true },
    metadataErrors: { type: Array, default: [] }, // [{ field, message }]
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    classification: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidentiality: { type: String, default: null },
    // Split / merge lineage (P11 / P12) — originals are never deleted
    parentDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    derivedFrom: [{ type: mongoose.Schema.Types.ObjectId, ref: 'File' }],
    // Split (P11): the original lists its parts; each part records where it came from
    // { fileId, splitId, part, pages: [original page numbers], via, hasTextLayer, prefill }
    splitInto: [{ type: mongoose.Schema.Types.ObjectId, ref: 'File' }],
    splitAt: { type: Date, default: null },
    splitBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    splitLock: { type: String, default: null },
    splitFrom: { type: mongoose.Schema.Types.Mixed, default: null },
    splitSuggestion: { type: mongoose.Schema.Types.Mixed, default: null }, // AI-suggested cuts

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
