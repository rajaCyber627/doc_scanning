const mongoose = require('mongoose');
const AuditEvent = require('./AuditEvent.model');
const { getPartner } = require('../../providers/partner');

const asId = (v) => (v && mongoose.isValidObjectId(v) ? v : null);

/**
 * Record one capture action and forward it to the partner. Never throws:
 * an audit failure must not break the user's request (it is logged instead).
 */
async function emitAudit({ userId = null, action, documentId = null, details = {} }) {
  try {
    const ev = await AuditEvent.create({
      userId: asId(userId),
      action,
      documentId: asId(documentId),
      details,
    });
    getPartner()
      .pushAuditEvent({
        id: String(ev._id),
        userId: ev.userId ? String(ev.userId) : null,
        action: ev.action,
        documentId: ev.documentId ? String(ev.documentId) : null,
        details: ev.details,
        at: ev.createdAt,
      })
      .catch((e) => console.error('partner audit push failed:', e && e.message));
    return ev;
  } catch (e) {
    console.error('audit write failed:', e && e.message);
    return null;
  }
}

module.exports = { emitAudit };
