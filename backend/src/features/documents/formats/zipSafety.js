// Safe ZIP reading (used for .zip uploads and as a zip-bomb check before opening
// Office/OpenDocument files, which are ZIPs inside). Limits: entry count, total
// uncompressed size, per-entry size, and suspicious compression ratios. Sizes are
// re-checked while decompressing, so a lying header cannot get past the limits.
const yauzl = require('yauzl');
const config = require('../../../core/config');
const { UserFacingError } = require('../../../core/errors');

const limitsFromConfig = () => ({
  maxEntries: config.formats.maxArchiveEntries,
  maxTotalBytes: config.formats.maxArchiveBytes,
  maxEntryBytes: config.upload.maxBytes,
  maxRatio: config.formats.maxCompressionRatio,
});

function open(buffer) {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (err, zip) =>
      err ? reject(new UserFacingError('DAMAGED_FILE', 'The archive is damaged and could not be opened.')) : resolve(zip)
    )
  );
}

/** List entries without decompressing; throws if the archive breaks a limit. */
async function listEntries(buffer, limits = limitsFromConfig()) {
  const zip = await open(buffer);
  const entries = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    zip.on('entry', (e) => {
      const isDir = /\/$/.test(e.fileName);
      const encrypted = (e.generalPurposeBitFlag & 0x1) === 1;
      total += e.uncompressedSize;
      if (entries.length + 1 > limits.maxEntries) {
        zip.close();
        return reject(new UserFacingError('ARCHIVE_TOO_LARGE', `The archive has more than ${limits.maxEntries} files.`));
      }
      if (total > limits.maxTotalBytes) {
        zip.close();
        return reject(new UserFacingError('ARCHIVE_TOO_LARGE', 'The archive expands to more data than is allowed.'));
      }
      const ratio = e.compressedSize > 0 ? e.uncompressedSize / e.compressedSize : 0;
      if (e.uncompressedSize > 10 * 1024 * 1024 && ratio > limits.maxRatio) {
        zip.close();
        return reject(new UserFacingError('ARCHIVE_SUSPICIOUS', 'The archive looks unsafe (extreme compression) and was not opened.'));
      }
      entries.push({ name: e.fileName, size: e.uncompressedSize, compressedSize: e.compressedSize, isDir, encrypted });
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.on('error', () => reject(new UserFacingError('DAMAGED_FILE', 'The archive is damaged and could not be read.')));
    zip.readEntry();
  });
  return entries;
}

/**
 * Decompress the entries `want(entry)` selects. Each entry and the running total are
 * capped while streaming. Returns [{ name, buffer }].
 */
async function readEntries(buffer, want, limits = limitsFromConfig()) {
  await listEntries(buffer, limits); // reject over-limit archives before inflating anything
  const zip = await open(buffer);
  const out = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    const fail = (e) => {
      zip.close();
      reject(e);
    };
    zip.on('entry', (e) => {
      const meta = {
        name: e.fileName,
        size: e.uncompressedSize,
        isDir: /\/$/.test(e.fileName),
        encrypted: (e.generalPurposeBitFlag & 0x1) === 1,
      };
      if (meta.isDir || meta.encrypted || !want(meta)) return zip.readEntry();
      zip.openReadStream(e, (err, stream) => {
        if (err) return fail(new UserFacingError('DAMAGED_FILE', `"${e.fileName}" inside the archive is damaged.`));
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          size += c.length;
          total += c.length;
          if (size > limits.maxEntryBytes || total > limits.maxTotalBytes) {
            stream.destroy();
            fail(new UserFacingError('ARCHIVE_TOO_LARGE', 'The archive expands to more data than is allowed.'));
          } else chunks.push(c);
        });
        stream.on('error', () => fail(new UserFacingError('DAMAGED_FILE', `"${e.fileName}" inside the archive is damaged.`)));
        stream.on('end', () => {
          out.push({ name: e.fileName, buffer: Buffer.concat(chunks) });
          zip.readEntry();
        });
      });
    });
    zip.on('end', resolve);
    zip.on('error', () => fail(new UserFacingError('DAMAGED_FILE', 'The archive is damaged and could not be read.')));
    zip.readEntry();
  });
  return out;
}

/** Zip-bomb check for ZIP-based documents (.docx/.xlsx/.pptx/.odt) before parsing them. */
async function assertSafeZipDocument(buffer) {
  await listEntries(buffer, { ...limitsFromConfig(), maxEntries: 5000, maxTotalBytes: 300 * 1024 * 1024 });
}

module.exports = { listEntries, readEntries, assertSafeZipDocument };
