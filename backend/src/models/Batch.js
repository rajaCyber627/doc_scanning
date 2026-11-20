const mongoose = require('mongoose');

// An intake batch: documents captured together (bulk upload, scan run, email pull,
// shared-drive import). A batch is an INTAKE concept (track progress, retry, report);
// a folder/set is an ORGANIZATION concept (where documents live). A batch may target
// a folder, but deleting or finishing a batch never moves or deletes documents.
const batchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    source: {
      type: String,
      enum: ['upload', 'camera', 'scanner', 'email', 'import'],
      default: 'upload',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    folderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: null },
    // The files the user selected, recorded up front so unfinished uploads can be
    // listed (and resumed or cancelled) even after a page refresh.
    items: [
      {
        _id: false,
        name: { type: String, required: true },
        size: { type: Number, required: true },
        path: { type: String, default: '' }, // relative path for folder uploads
        cancelled: { type: Boolean, default: false },
      },
    ],
    // open: files still being submitted · processing: all submitted, work pending ·
    // completed: nothing left uploading or processing
    status: { type: String, enum: ['open', 'processing', 'completed'], default: 'open' },
    closedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    counts: {
      total: { type: Number, default: 0 },
      uploaded: { type: Number, default: 0 },
      uploading: { type: Number, default: 0 },
      processing: { type: Number, default: 0 },
      ready: { type: Number, default: 0 },
      needsReview: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      uploadFailed: { type: Number, default: 0 },
      notUploaded: { type: Number, default: 0 },
      cancelled: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Batch', batchSchema);
