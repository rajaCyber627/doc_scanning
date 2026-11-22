// Local email source: a folder of .eml / .msg files (development and tests — no Microsoft
// tenant needed). New messages are files in the folder; handled ones move to Processed/ or
// Rejected/, mirroring the mailbox folders of the Graph source.
const fs = require('fs/promises');
const path = require('path');

function localSource(dir) {
  const move = async (id, folder) => {
    const target = path.join(dir, folder);
    await fs.mkdir(target, { recursive: true });
    let dest = path.join(target, id);
    for (let n = 1; await fs.access(dest).then(() => true, () => false); n++) dest = path.join(target, id.replace(/(\.[^.]+)$/, ` (${n})$1`));
    await fs.rename(path.join(dir, id), dest);
  };
  return {
    kind: 'local',
    label: dir,
    async list(max = 50) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
        if (e.code === 'ENOENT') throw new Error(`The local email folder "${dir}" does not exist`);
        throw e;
      });
      const files = entries.filter((e) => e.isFile() && /\.(eml|msg)$/i.test(e.name) && !e.name.startsWith('.'));
      const withTime = await Promise.all(files.map(async (e) => ({ id: e.name, receivedAt: (await fs.stat(path.join(dir, e.name))).mtime })));
      return withTime.sort((a, b) => a.receivedAt - b.receivedAt).slice(0, max);
    },
    async fetch(id) {
      return { raw: await fs.readFile(path.join(dir, id)), format: /\.msg$/i.test(id) ? 'msg' : 'eml' };
    },
    markProcessed: (id) => move(id, 'Processed'),
    markRejected: (id) => move(id, 'Rejected'),
  };
}

module.exports = { localSource };
