// External service clients, created once. Explicit keys are used only if set;
// otherwise the SDK's default chain applies (e.g. the EC2 instance role).
// Tests replace this whole module with tests/fakes/clients.js.
const AWS = require('aws-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

const { aws } = config;

const s3 = new AWS.S3({
  region: aws.region,
  ...(aws.accessKeyId && {
    accessKeyId: aws.accessKeyId,
    secretAccessKey: aws.secretAccessKey,
  }),
});

const textract = new AWS.Textract({
  region: aws.textractRegion,
  ...(aws.textractAccessKeyId && {
    accessKeyId: aws.textractAccessKeyId,
    secretAccessKey: aws.textractSecretAccessKey,
  }),
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = { s3, textract, anthropic, BUCKET: aws.bucket };
