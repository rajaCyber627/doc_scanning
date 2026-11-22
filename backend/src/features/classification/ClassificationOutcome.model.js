const mongoose = require('mongoose');

// What the AI suggested vs. what the reviewer kept — the basis for accuracy tracking.
const outcomeSchema = new mongoose.Schema(
  {
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    model: { type: String, default: null },
    suggestedType: { type: String, default: null },
    finalType: { type: String, default: null, index: true },
    typeCorrect: { type: Boolean, default: false },
    // [{ field, suggested, final, accepted }]
    fields: { type: Array, default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('ClassificationOutcome', outcomeSchema);
