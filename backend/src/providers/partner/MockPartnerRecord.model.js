const mongoose = require('mongoose');

// What MockPartnerAdapter "sent" to the partner HRDMS. Local development only.
const mockPartnerRecordSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['document', 'audit'], required: true, index: true },
    sha256: { type: String, default: null, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('MockPartnerRecord', mockPartnerRecordSchema);
