// The only way the Capture Hub talks to the partner HRDMS (system of record).
// The partner's real API is not known yet; implement a subclass when it is, and
// select it with PARTNER_ADAPTER. No feature may call the partner directly.
class PartnerAdapter {
  /**
   * Hand a captured document to the partner.
   * @param {object} document  hub document record
   * @param {object} payload   { files, metadata, indexPayload } (shape defined in P07)
   * @returns {Promise<{ partnerDocumentId: string }>}
   */
  // eslint-disable-next-line no-unused-vars
  async pushDocument(document, payload) {
    throw new Error('PartnerAdapter.pushDocument not implemented');
  }

  /** Forward one audit event (user, action, document, timestamp, details). */
  // eslint-disable-next-line no-unused-vars
  async pushAuditEvent(event) {
    throw new Error('PartnerAdapter.pushAuditEvent not implemented');
  }

  /**
   * Does the partner already hold a document with this SHA-256?
   * @returns {Promise<null | { partnerDocumentId: string, restricted: boolean }>}
   */
  // eslint-disable-next-line no-unused-vars
  async findByHash(sha256) {
    throw new Error('PartnerAdapter.findByHash not implemented');
  }

  /**
   * Find employees / applicants / retirees by name or ID.
   * @returns {Promise<Array<{ personId, type, name, employeeId, applicantNumber,
   *   positionTitle, department, division, status }>>}
   */
  // eslint-disable-next-line no-unused-vars
  async lookupPerson(query) {
    throw new Error('PartnerAdapter.lookupPerson not implemented');
  }
}

/** One person by the partner's id (used to verify a picked person server-side). */
// eslint-disable-next-line no-unused-vars
PartnerAdapter.prototype.getPerson = async function getPerson(personId) {
  throw new Error('PartnerAdapter.getPerson not implemented');
};

module.exports = PartnerAdapter;
