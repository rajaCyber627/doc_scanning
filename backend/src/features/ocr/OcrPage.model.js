const mongoose = require('mongoose');

// One OCR'd page. Stored separately from the File so documents of any length stay
// well under MongoDB's 16 MB record limit (no word cap any more).
const ocrPageSchema = new mongoose.Schema(
  {
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', required: true, index: true },
    page: { type: Number, required: true },
    text: { type: String, default: '' },
    confidence: { type: Number, default: null }, // average word confidence, %
    handwritingRatio: { type: Number, default: 0 },
    skewDegrees: { type: Number, default: 0 },
    // Compact word boxes: t=text, c=confidence, hw=handwritten, x/y/w/h normalized 0–1
    words: { type: Array, default: [] },
    keyValues: { type: Array, default: [] }, // [{ key, value, confidence }]
    tables: { type: Array, default: [] }, // [{ rows: [[...]] }]
  },
  { timestamps: true }
);
ocrPageSchema.index({ fileId: 1, page: 1 }, { unique: true });

module.exports = mongoose.model('OcrPage', ocrPageSchema);
