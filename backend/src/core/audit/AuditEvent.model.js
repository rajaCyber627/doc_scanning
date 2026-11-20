const mongoose = require('mongoose');

// Append-only record of capture activity (RFP audit trail: user, action,
// document, date, time). Also forwarded to the partner HRDMS.
const auditEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    action: { type: String, required: true, index: true },
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null, index: true },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Audit events cannot be edited once written.
function blockUpdate(next) {
  next(new Error('Audit events are append-only'));
}
['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'].forEach((op) =>
  auditEventSchema.pre(op, blockUpdate)
);
auditEventSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('Audit events are append-only'));
  next();
});

module.exports = mongoose.model('AuditEvent', auditEventSchema);
