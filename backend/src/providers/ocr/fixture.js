// OCR from saved Textract responses — lets the whole OCR flow run in development and
// demos while Textract is not activated. Looks for, in order:
//   <OCR_FIXTURE_DIR>/<sha256 of the file>.json
//   <OCR_FIXTURE_DIR>/<original file name>.json
//   <OCR_FIXTURE_DIR>/default.json
// Each file is a Textract response ({ "Blocks": [...] }).
const fs = require('fs/promises');
const path = require('path');
const config = require('../../core/config');
const { UserFacingError } = require('../../core/errors');
const { normalizeBlocks } = require('./normalize');

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function analyze(key, { sha256, fileName } = {}) {
  const dir = config.ocr.fixtureDir;
  const candidates = [sha256 && `${sha256}.json`, fileName && `${path.basename(fileName)}.json`, 'default.json'].filter(Boolean);
  for (const c of candidates) {
    const data = await readJson(path.join(dir, c));
    if (data && Array.isArray(data.Blocks)) return { ...normalizeBlocks(data.Blocks), provider: 'fixture', mode: c };
  }
  throw new UserFacingError('OCR_FIXTURE_MISSING', `No saved OCR result for "${fileName || key}" (OCR is in fixture mode).`);
}

module.exports = { analyze };
