// S3 client. Explicit keys only if set; otherwise the SDK default chain applies
// (e.g. the EC2 instance role). Tests replace this module with a fake.
const AWS = require('aws-sdk');
const config = require('../../core/config');

const { aws } = config;

const s3 = new AWS.S3({
  region: aws.region,
  ...(aws.accessKeyId && {
    accessKeyId: aws.accessKeyId,
    secretAccessKey: aws.secretAccessKey,
  }),
});

module.exports = { s3, BUCKET: aws.bucket };
