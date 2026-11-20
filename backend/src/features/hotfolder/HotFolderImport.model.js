const mongoose = require('mongoose');

// One file seen in a scanner hot folder: imported (→ document) or rejected (with why).
// (profile, path, size, mtime) identifies a file version, so nothing is imported twice.
const schema = new mongoose.Schema(
  {
    profile: { type: String, required: true },
    path: { type: String, required: true },
    size: { type: Number, default: 0 },
    mtime: { type: Date, default: null },
    status: { type: String, enum: ['imported', 'rejected'], required: true },
    reason: { type: String, default: '' },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    sha256: { type: String, default: null },
  },
  { timestamps: true }
);
schema.index({ profile: 1, path: 1, size: 1, mtime: 1 }, { unique: true });

module.exports = mongoose.model('HotFolderImport', schema);
