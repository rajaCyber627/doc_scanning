const mongoose = require('mongoose');

// Admin settings stored in the database (changeable without a restart), e.g.
// key "classification" → { aiEnabled, autoAccept, autoAcceptThreshold, typeThresholds }.
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Setting', settingSchema);
