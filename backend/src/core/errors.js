// Turn raw service errors into messages a user can act on, and decide whether
// retrying could help. Unknown errors keep their original message and retry.
const RULES = [
  {
    test: (e) =>
      e.code === 'SubscriptionRequiredException' || /needs a subscription for the service/i.test(e.message),
    code: 'OCR_NOT_ACTIVATED',
    message: 'OCR service (AWS Textract) is not activated on the AWS account. Images and scanned PDFs cannot be read until it is activated.',
    retryable: false,
  },
  {
    test: (e) => e.code === 'AccessDeniedException' || e.code === 'AccessDenied' || /not authorized/i.test(e.message),
    code: 'ACCESS_DENIED',
    message: 'The server is not permitted to use a required cloud service (access denied). Check the AWS permissions.',
    retryable: false,
  },
  {
    test: (e) => e.code === 'NoSuchKey' || /specified key does not exist/i.test(e.message),
    code: 'FILE_MISSING',
    message: 'The uploaded file could not be found in storage. Please upload it again.',
    retryable: false,
  },
  {
    test: (e) => e.code === 'UnsupportedDocumentException' || /unsupported document format/i.test(e.message),
    code: 'UNSUPPORTED_DOCUMENT',
    message: 'This file format could not be read. Try saving it as PDF and uploading again.',
    retryable: false,
  },
  {
    test: (e) => /password|encrypted|PasswordException/i.test(e.message) || e.name === 'PasswordException',
    code: 'PASSWORD_PROTECTED',
    message: 'This file is password-protected. Remove the password and upload it again.',
    retryable: false,
  },
  {
    test: (e) => e.code === 'BadDocumentException' || e.code === 'InvalidPDFException' || /invalid pdf|bad xref/i.test(e.message),
    code: 'DAMAGED_FILE',
    message: 'The file appears to be damaged or password-protected and could not be read.',
    retryable: false,
  },
  {
    test: (e) =>
      /BSONObjectTooLarge|document is larger than the maximum size|"offset" is out of range/i.test(e.message),
    code: 'DOCUMENT_TOO_LARGE',
    message: 'This document produced more data than can be stored in one record. Split it into smaller files and upload again.',
    retryable: false,
  },
  {
    test: (e) => e.code === 'ThrottlingException' || e.code === 'ProvisionedThroughputExceededException' || e.status === 429,
    code: 'RATE_LIMITED',
    message: 'A cloud service is busy (rate limited). The document will be retried automatically.',
    retryable: true,
  },
];

/** Errors already worded for users (format problems, limits). Never retried by default. */
class UserFacingError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function humanizeError(err) {
  if (err instanceof UserFacingError) return { code: err.code, message: err.message, retryable: err.retryable, raw: err.message };
  const e = err || {};
  const raw = String(e.message || e || 'Processing failed');
  for (const r of RULES) {
    try {
      if (r.test({ ...e, message: raw })) return { code: r.code, message: r.message, retryable: r.retryable, raw };
    } catch {
      /* ignore a bad rule */
    }
  }
  return { code: 'PROCESSING_ERROR', message: raw.slice(0, 500), retryable: true, raw };
}

module.exports = { humanizeError, UserFacingError };
