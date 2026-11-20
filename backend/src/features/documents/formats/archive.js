// ZIP archives: each file inside becomes its own child document. Folders, OS clutter
// and password-protected entries are skipped (with a reason for the latter).
const path = require('path');
const { listEntries, readEntries } = require('./zipSafety');

const CLUTTER = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|~\$)/i;

async function expandZip(buffer) {
  const entries = await listEntries(buffer);
  const files = entries.filter((e) => !e.isDir && !CLUTTER.test(e.name));
  const skipped = files.filter((e) => e.encrypted).map((e) => ({ name: e.name, reason: 'Password-protected inside the archive' }));
  const read = await readEntries(buffer, (e) => !CLUTTER.test(e.name));
  const children = read.map((r) => ({ fileName: path.posix.basename(r.name), path: r.name, buffer: r.buffer }));
  const listing = files.map((e) => `${e.name} (${e.size.toLocaleString('en-US')} bytes)`).join('\n');
  return { text: `Archive contents (${files.length} files):\n${listing}`, children, skipped };
}

module.exports = { expandZip };
