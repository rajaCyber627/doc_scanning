const mongoose = require('mongoose');

// Record categories (RFP pp. 5–8): e.g. Personnel, Benefits, Medical & Confidential…
const categorySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    hrFunctionalArea: { type: String, default: '' },
    defaultConfidentiality: { type: String, default: 'Confidential' },
    defaultRetentionCategory: { type: String, default: '' },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const fieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, required: true },
    required: { type: Boolean, default: false },
    options: { type: [String], default: undefined },
    help: { type: String, default: undefined },
  },
  { _id: false }
);

// Document types within a category, each with its own fields and defaults.
const documentTypeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    categoryKey: { type: String, required: true, index: true },
    defaultConfidentiality: { type: String, default: 'Confidential' },
    defaultRetentionCategory: { type: String, default: '' },
    fields: { type: [fieldSchema], default: [] },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const RecordCategory = mongoose.model('RecordCategory', categorySchema);
const DocumentType = mongoose.model('DocumentType', documentTypeSchema);

module.exports = { RecordCategory, DocumentType };
