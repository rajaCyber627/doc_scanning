// S3 storage helpers. Everything that touches S3 goes through here (or client.js).
const { s3, BUCKET } = require('./client');

async function s3GetBuffer(key) {
  const obj = await s3.getObject({ Bucket: BUCKET, Key: key }).promise();
  return obj.Body;
}

/** First `length` bytes of an object (for file-type sniffing). */
async function readHead(key, length = 4096) {
  const obj = await s3.getObject({ Bucket: BUCKET, Key: key, Range: `bytes=0-${length - 1}` }).promise();
  return Buffer.from(obj.Body);
}

/** { size, contentType } or null when the object does not exist. */
async function headObject(key) {
  try {
    const h = await s3.headObject({ Bucket: BUCKET, Key: key }).promise();
    return { size: Number(h.ContentLength), contentType: h.ContentType || '' };
  } catch (e) {
    if (e.code === 'NotFound' || e.code === 'NoSuchKey' || e.statusCode === 404) return null;
    throw e;
  }
}

function presignPut(key, contentType, expiresSec) {
  return s3.getSignedUrl('putObject', { Bucket: BUCKET, Key: key, ContentType: contentType, Expires: expiresSec });
}

async function createMultipart(key, contentType) {
  const r = await s3.createMultipartUpload({ Bucket: BUCKET, Key: key, ContentType: contentType }).promise();
  return r.UploadId;
}

function presignPart(key, uploadId, partNumber, expiresSec) {
  return s3.getSignedUrl('uploadPart', {
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
    Expires: expiresSec,
  });
}

async function completeMultipart(key, uploadId, parts) {
  await s3
    .completeMultipartUpload({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .map((p) => ({ ETag: p.ETag, PartNumber: Number(p.PartNumber) }))
          .sort((a, b) => a.PartNumber - b.PartNumber),
      },
    })
    .promise();
}

async function abortMultipart(key, uploadId) {
  await s3.abortMultipartUpload({ Bucket: BUCKET, Key: key, UploadId: uploadId }).promise();
}

/** Stream a body (Buffer or readable stream) to S3; handles large bodies itself. */
async function putStream(key, body, contentType) {
  await s3.upload({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }).promise();
}

/** Objects under a prefix: [{ key, size, lastModified }] (paged through). */
async function listObjects(prefix, max = 1000) {
  const out = [];
  let token;
  do {
    const r = await s3.listObjectsV2({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token, MaxKeys: Math.min(1000, max - out.length) }).promise();
    for (const o of r.Contents || []) out.push({ key: o.Key, size: Number(o.Size), lastModified: o.LastModified ? new Date(o.LastModified) : null });
    token = r.IsTruncated ? r.NextContinuationToken : null;
  } while (token && out.length < max);
  return out;
}

async function deleteObject(key) {
  await s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
}

module.exports = {
  s3GetBuffer,
  readHead,
  headObject,
  presignPut,
  createMultipart,
  presignPart,
  completeMultipart,
  abortMultipart,
  putStream,
  deleteObject,
  listObjects,
};
