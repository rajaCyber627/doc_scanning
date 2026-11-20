// Optional high-fidelity Office → PDF conversion with headless LibreOffice.
// Used when `soffice` is installed (or SOFFICE_PATH is set); otherwise callers fall
// back to a text-based PDF. Each conversion gets its own temp profile so parallel
// conversions don't collide.
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../../core/config');

const CANDIDATES = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
  '/usr/bin/libreoffice',
  '/usr/local/bin/soffice',
  '/opt/libreoffice/program/soffice',
  '/snap/bin/libreoffice',
];

let resolved; // undefined = not checked yet, null = not available

function sofficePath() {
  if (resolved !== undefined) return resolved;
  const configured = config.formats.sofficePath;
  resolved = [configured, ...CANDIDATES].find((p) => p && fsSync.existsSync(p)) || null;
  return resolved;
}

const isAvailable = () => !!sofficePath();

async function convertToPdf(buffer, ext, timeoutMs = 120000) {
  const bin = sofficePath();
  if (!bin) throw new Error('LibreOffice is not installed');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docp-convert-'));
  try {
    const input = path.join(dir, `input.${ext}`);
    await fs.writeFile(input, buffer);
    await new Promise((resolve, reject) =>
      execFile(
        bin,
        [
          '--headless',
          '--norestore',
          '--nolockcheck',
          `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          input,
        ],
        { timeout: timeoutMs },
        (err) => (err ? reject(err) : resolve())
      )
    );
    return await fs.readFile(path.join(dir, 'input.pdf'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { isAvailable, convertToPdf };
