// OCR for one document: clean up the image (upright, straighten), run the OCR provider,
// store per-page results (OcrPage), and judge quality (review reasons).
const config = require('../../core/config');
const storage = require('../../providers/storage');
const { getOcrProvider } = require('../../providers/ocr');
const File = require('../../models/File');
const OcrPage = require('./OcrPage.model');
const { qualityReasons, splitQuality, rotationOf, fold } = require('./quality');
const { uprightByExif, straighten } = require('./preprocess');

const MAX_KEY_VALUES = 200;

async function saveConverted(file, jpeg) {
  const key = `${file.s3Key}.converted.jpg`;
  await storage.putStream(key, jpeg, 'image/jpeg');
  // record right away so it is displayed and cleaned up even if OCR then fails
  await File.updateOne({ _id: file._id }, { ocrSourceS3Key: key });
  return key;
}

async function storePages(fileId, pages) {
  await OcrPage.deleteMany({ fileId });
  if (!pages.length) return;
  await OcrPage.insertMany(
    pages.map((p) => ({
      fileId,
      page: p.page,
      text: p.text,
      confidence: p.confidence,
      handwritingRatio: p.handwritingRatio,
      skewDegrees: p.skewDegrees,
      words: p.words,
      keyValues: p.keyValues,
      tables: p.tables,
    }))
  );
}

/**
 * @param file     the File document (needs _id, s3Key, fileName, sha256)
 * @param opts.image  { buffer, mime } when the document is a single image that may be
 *                    cleaned up (upright / straightened) before OCR; omit for PDFs/TIFFs
 * @param opts.ocrKey S3 key to OCR when it is not the original (e.g. converted HEIC)
 * @returns { rawText, tablesCsv, ocr, reviewReasons, ocrSourceS3Key?, convertedImage? }
 */
async function runOcr(file, { image = null, ocrKey = null } = {}) {
  const provider = getOcrProvider();
  let key = ocrKey || file.s3Key;
  let imageBuf = image ? image.buffer : null;
  let ocrSourceS3Key = ocrKey && ocrKey !== file.s3Key ? ocrKey : null;

  // 1) Phone photos: apply the EXIF rotation so text is upright for OCR and display.
  if (image) {
    const upright = await uprightByExif(image.buffer, image.mime).catch(() => null);
    if (upright) {
      imageBuf = upright;
      key = ocrSourceS3Key = await saveConverted(file, upright);
    }
  }

  const opts = { forms: config.ocr.forms, sha256: file.sha256, fileName: file.fileName };
  let result = await provider.analyze(key, opts);
  let corrected = false;

  // 2) Single image scanned at an angle or sideways: straighten it and read it again (once).
  if (imageBuf && result.pages.length === 1) {
    const skew = fold(result.pages[0].skewDegrees || 0);
    if (Math.abs(skew) >= config.ocr.skewDegrees && result.pages[0].words.length >= config.ocr.blankPageWords) {
      const { degrees } = rotationOf(skew);
      const fixed = await straighten(imageBuf, degrees).catch(() => null);
      if (fixed) {
        const fixedKey = await saveConverted(file, fixed);
        const second = await provider.analyze(fixedKey, opts);
        if (Math.abs(fold(second.pages[0]?.skewDegrees || 0)) < Math.abs(skew)) {
          result = second;
          imageBuf = fixed;
          key = ocrSourceS3Key = fixedKey;
          corrected = true;
        }
      }
    }
  }

  await storePages(file._id, result.pages);
  const { reviewReasons, notes } = splitQuality(qualityReasons(result.pages, { corrected }).map((r) => ({ ...r, stage: 'ocr' })), result.pages);
  const confs = result.pages.map((p) => p.confidence).filter((c) => typeof c === 'number');
  return {
    rawText: result.text,
    tablesCsv: result.tablesCsv,
    pageCount: result.pages.length,
    ocr: {
      provider: result.provider,
      mode: result.mode,
      pages: result.pages.length,
      avgConfidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10 : null,
      corrected,
      keyValues: result.keyValues.slice(0, MAX_KEY_VALUES),
    },
    reviewReasons,
    notes,
    ocrSourceS3Key,
    convertedImage: ocrSourceS3Key ? imageBuf : null,
  };
}

module.exports = { runOcr };
