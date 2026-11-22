// AWS Textract client. Explicit keys only if set; otherwise the SDK default chain.
// Tests replace this module with a fake.
const AWS = require('aws-sdk');
const config = require('../../core/config');

const { aws } = config;

const textract = new AWS.Textract({
  region: aws.textractRegion,
  ...(aws.textractAccessKeyId && {
    accessKeyId: aws.textractAccessKeyId,
    secretAccessKey: aws.textractSecretAccessKey,
  }),
});

module.exports = { textract };
