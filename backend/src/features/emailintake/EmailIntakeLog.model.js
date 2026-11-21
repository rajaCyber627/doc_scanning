const mongoose = require('mongoose');

// One message seen in the intake mailbox. Only identifiers are kept — sender, a hash of
// the subject, the Message-ID — never the body (the body, if worth filing, is a document).
const schema = new mongoose.Schema(
  {
    source: { type: String, required: true }, // graph | local
    sourceId: { type: String, required: true }, // Graph message id / file name
    messageId: { type: String, default: '', index: true }, // RFC 5322 Message-ID
    from: { type: String, default: '' },
    subjectHash: { type: String, default: '' },
    status: { type: String, enum: ['imported', 'rejected', 'duplicate', 'failed'], required: true },
    reason: { type: String, default: '' },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    attachments: { type: Number, default: 0 },
  },
  { timestamps: true }
);
schema.index({ source: 1, sourceId: 1 });

module.exports = mongoose.model('EmailIntakeLog', schema);
