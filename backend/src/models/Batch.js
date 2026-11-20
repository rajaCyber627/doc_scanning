const mongoose = require('mongoose');

// An intake batch: a group of documents captured together (bulk upload, scan run,
// email pull, shared-drive import). Batches are an intake concept; folders/sets
// are an organization concept. Populated from P03 onwards.
const batchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    source: {
      type: String,
      enum: ['upload', 'camera', 'scanner', 'email', 'import'],
      default: 'upload',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['open', 'processing', 'completed'], default: 'open' },
    counts: {
      total: { type: Number, default: 0 },
      processing: { type: Number, default: 0 },
      ready: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Batch', batchSchema);
