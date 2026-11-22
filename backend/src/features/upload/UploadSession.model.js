const mongoose = require('mongoose');

// One file being uploaded. Created before any bytes are sent; on "complete" the
// server verifies the stored object and turns it into a File document.
const uploadSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fileName: { type: String, required: true },
    ext: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    s3Key: { type: String, required: true, unique: true },
    transport: { type: String, enum: ['direct', 'proxy'], required: true },
    // Direct multipart uploads only
    s3UploadId: { type: String, default: null },
    partSizeBytes: { type: Number, default: null },
    partCount: { type: Number, default: null },
    // Where the document should land + optional hints for later stages (P09/P10)
    folderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: null },
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', default: null },
    hints: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['pending', 'completed', 'aborted', 'failed'], default: 'pending', index: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    error: { type: String, default: '' },
    // Pending sessions expire (MongoDB TTL); cleared when the session finishes.
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

uploadSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('UploadSession', uploadSessionSchema);
