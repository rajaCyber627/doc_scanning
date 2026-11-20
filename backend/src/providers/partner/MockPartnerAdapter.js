// Local stand-in for the partner HRDMS: records what would be sent and serves
// sample people from seed-people.json.
const PartnerAdapter = require('./PartnerAdapter');
const MockPartnerRecord = require('./MockPartnerRecord.model');
const people = require('./seed-people.json');

class MockPartnerAdapter extends PartnerAdapter {
  async pushDocument(document, payload = {}) {
    const rec = await MockPartnerRecord.create({
      kind: 'document',
      sha256: document.sha256 || null,
      payload: { documentId: String(document._id), fileName: document.fileName, ...payload },
    });
    return { partnerDocumentId: `mock-${rec._id}` };
  }

  async pushAuditEvent(event) {
    await MockPartnerRecord.create({ kind: 'audit', payload: event });
  }

  async findByHash(sha256) {
    if (!sha256) return null;
    const rec = await MockPartnerRecord.findOne({ kind: 'document', sha256 });
    return rec
      ? { partnerDocumentId: `mock-${rec._id}`, restricted: !!(rec.payload && rec.payload.restricted) }
      : null;
  }

  async lookupPerson(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return people.filter((p) =>
      [p.name, p.employeeId, p.applicantNumber].some((v) => v && String(v).toLowerCase().includes(q))
    );
  }
}

module.exports = MockPartnerAdapter;
