// Delete a document and everything stored for it (S3 original + extracted text,
// saved tables, search chunks). Used by document and folder deletion.
const File = require('../../models/File');
const TableResult = require('../tables/TableResult.model');
const Chunk = require('../query/Chunk.model');
const OcrPage = require('../ocr/OcrPage.model');
const storage = require('../../providers/storage');
const events = require('../../core/events');

async function removeDocument(file) {
  for (const key of [file.s3Key, file.textS3Key, file.renditionS3Key, file.ocrSourceS3Key].filter(Boolean)) {
    try {
      await storage.deleteObject(key);
    } catch (e) {
      console.error('s3 delete failed:', e && e.message);
    }
  }
  await TableResult.deleteMany({ fileId: file._id });
  await Chunk.deleteMany({ fileId: file._id });
  await OcrPage.deleteMany({ fileId: file._id });
  await File.findByIdAndDelete(file._id);
  if (file.batchId) events.emit('batch.touch', String(file.batchId));
}

module.exports = { removeDocument };
