// S3 helpers.
const { s3, BUCKET } = require('../clients');

async function s3GetBuffer(key) {
  const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
  return obj.Body;
}

module.exports = { s3GetBuffer };
