// Image conversions: HEIC/GIF/BMP → JPEG (Textract and browsers cannot read them all),
// and multi-page TIFF → one JPEG per page (for the PDF view).
const Jimp = require('jimp');
const UTIF = require('utif');
const heicConvert = require('heic-convert');
const { UserFacingError } = require('../../../core/errors');

const JPEG_QUALITY = 88;

const hasTransparency = (img) => {
  const d = img.bitmap.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
};

/** Transparent areas become white. Without this, JPEG/OCR see them as black (their colour
 *  value is usually 0,0,0), so black text on a transparent background reads as a blank page. */
function onWhite(img) {
  if (!hasTransparency(img)) return img;
  return new Jimp(img.bitmap.width, img.bitmap.height, 0xffffffff).composite(img, 0, 0);
}

async function jimpToJpeg(img) {
  const flat = onWhite(img);
  flat.quality(JPEG_QUALITY);
  return flat.getBufferAsync(Jimp.MIME_JPEG);
}

/** PNG with transparency → JPEG on white (for OCR and viewing); null when fully opaque. */
async function flattenPng(buffer) {
  let img;
  try {
    img = await Jimp.read(buffer);
  } catch {
    return null; // unreadable here: let OCR try the original
  }
  return hasTransparency(img) ? jimpToJpeg(img) : null;
}

/** JPEG version of an image Textract/browsers can't read directly. */
async function toJpeg(ext, buffer) {
  try {
    if (ext === 'heic' || ext === 'heif') {
      return Buffer.from(await heicConvert({ buffer, format: 'JPEG', quality: JPEG_QUALITY / 100 }));
    }
    return await jimpToJpeg(await Jimp.read(buffer)); // gif (first frame), bmp
  } catch {
    throw new UserFacingError('DAMAGED_FILE', 'This image could not be converted. It may be damaged or use an unusual format.');
  }
}

/** Every page of a (multi-page) TIFF as JPEG, up to maxPages. */
async function tiffPagesToJpeg(buffer, maxPages) {
  let ifds;
  try {
    ifds = UTIF.decode(buffer);
  } catch {
    throw new UserFacingError('DAMAGED_FILE', 'This TIFF image could not be read.');
  }
  const pages = [];
  for (const ifd of ifds.slice(0, maxPages)) {
    UTIF.decodeImage(buffer, ifd);
    if (!ifd.width || !ifd.height) continue;
    const rgba = Buffer.from(UTIF.toRGBA8(ifd));
    const img = await new Promise((resolve, reject) =>
      // eslint-disable-next-line no-new
      new Jimp({ data: rgba, width: ifd.width, height: ifd.height }, (err, im) => (err ? reject(err) : resolve(im)))
    );
    pages.push(await jimpToJpeg(img));
  }
  return { pages, pageCount: ifds.length };
}

module.exports = { toJpeg, tiffPagesToJpeg, flattenPng };
