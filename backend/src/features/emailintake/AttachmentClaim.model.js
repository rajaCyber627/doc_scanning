const mongoose = require('mongoose');

// Short-lived claim on an e-mailed file's SHA-256, so that two emails carrying the same
// file and processed at the same moment store it once (the unique index decides). Later
// copies are caught by the normal "already captured" check; claims expire after an hour.
const schema = new mongoose.Schema({
  sha256: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

module.exports = mongoose.model('EmailAttachmentClaim', schema);
