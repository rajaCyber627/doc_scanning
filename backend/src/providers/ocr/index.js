// The OCR provider in use (OCR_PROVIDER = textract | fixture). Both return the same
// normalized result, so the rest of the app never depends on a specific service.
const config = require('../../core/config');

const PROVIDERS = {
  textract: () => require('./textract'),
  fixture: () => require('./fixture'),
};

function getOcrProvider() {
  const load = PROVIDERS[config.ocr.provider];
  if (!load) throw new Error(`Unknown OCR_PROVIDER "${config.ocr.provider}"`);
  return { name: config.ocr.provider, ...load() };
}

module.exports = { getOcrProvider };
