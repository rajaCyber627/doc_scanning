const mongoose = require('mongoose');

// The full-text index record for one document (built by the "index" stage, rebuilt on
// every change). Carries the access fields so search can hide restricted documents
// without leaking that they exist.
const searchDocSchema = new mongoose.Schema(
  {
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    folderId: { type: mongoose.Schema.Types.ObjectId, default: null },
    batchId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    status: { type: String, index: true },
    confidentiality: { type: String, default: null, index: true },
    documentType: { type: String, default: null, index: true },
    recordCategory: { type: String, default: null },
    fileName: { type: String, default: '' },
    text: { type: String, default: '' }, // normalized full text (capped like File.rawText)
    textTruncated: { type: Boolean, default: false },
    pages: [{ _id: false, page: Number, start: Number, end: Number }], // offsets into text
    lang: { type: String, default: 'en' }, // ISO code for the partner payload
    language: { type: String, default: 'english' }, // MongoDB stemming language
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    docCreatedAt: { type: Date, index: true },
    indexedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

searchDocSchema.index(
  { fileName: 'text', text: 'text', 'metadata.employeeName': 'text', 'metadata.employeeId': 'text' },
  { name: 'fulltext', weights: { fileName: 10, 'metadata.employeeName': 8, 'metadata.employeeId': 8, text: 1 }, default_language: 'english', language_override: 'language' }
);
searchDocSchema.index({ userId: 1, docCreatedAt: -1 });

module.exports = mongoose.model('SearchDoc', searchDocSchema);
