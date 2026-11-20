// Image clean-up for camera/scanner pictures before OCR:
//  • uprightByExif: phone photos often store "rotate me" in EXIF instead of rotating the
//    pixels; Textract and browsers don't always honour it, so bake it in.
//  • straighten: rotate by the tilt Textract measured (skew) or a quarter turn.
const Jimp = require('jimp');
const ExifParser = require('exif-parser');

function exifOrientation(buffer) {
  try {
    return ExifParser.create(buffer).parse().tags.Orientation || 1;
  } catch {
    return 1;
  }
}

/**
 * Encode pixels as a fresh JPEG. jimp would otherwise write the original EXIF back —
 * including the old Orientation tag — so viewers that honour it would rotate the
 * already-rotated image a second time.
 */
async function freshJpeg(img) {
  const { data, width, height } = img.bitmap;
  const clean = await new Promise((resolve, reject) =>
    // eslint-disable-next-line no-new
    new Jimp({ data: Buffer.from(data), width, height }, (err, im) => (err ? reject(err) : resolve(im)))
  );
  clean.quality(90);
  return clean.getBufferAsync(Jimp.MIME_JPEG);
}

/** JPEG rotated upright if its EXIF says so; null if nothing to do. */
async function uprightByExif(buffer, mime) {
  if (mime !== 'image/jpeg' || exifOrientation(buffer) < 2) return null;
  const img = await Jimp.read(buffer); // jimp applies the EXIF orientation when reading
  return freshJpeg(img);
}

/** Rotate counter-clockwise by `degrees` (corrects a clockwise tilt); white fill. */
async function straighten(buffer, degrees) {
  const img = await Jimp.read(buffer);
  img.background(0xffffffff).rotate(degrees, true);
  return freshJpeg(img);
}

module.exports = { uprightByExif, straighten, exifOrientation };
