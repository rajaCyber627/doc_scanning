// Fill in valid standard metadata so a document may be handed to the partner.
const request = require('supertest');

async function completeMetadata(app, fileId, userId, extra = {}) {
  const res = await request(app)
    .put(`/api/files/${fileId}/metadata`)
    .send({ userId: String(userId), metadata: { documentType: 'personnel.other-official-personnel-documents', personId: 'emp-1045', ...extra } });
  if (res.status !== 200 || res.body.metadataStatus !== 'complete') throw new Error(`metadata not complete: ${JSON.stringify(res.body)}`);
  return res.body;
}

module.exports = { completeMetadata };
