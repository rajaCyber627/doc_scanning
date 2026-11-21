// Local / network folder source (an SMB share mounted on the machine running the tool).
// Read-only: files are listed, hashed and read — never changed, moved or deleted.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function localSource(root) {
  const base = path.resolve(root);
  const abs = (rel) => {
    const p = path.resolve(base, rel);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Path outside the source');
    return p;
  };
  return {
    kind: 'local',
    key: `local:${base}`,
    label: base,
    async *walk() {
      const stack = [''];
      while (stack.length) {
        const rel = stack.pop();
        let entries;
        try {
          entries = await fsp.readdir(abs(rel), { withFileTypes: true });
        } catch (e) {
          if (!rel) throw new Error(`The source folder "${base}" cannot be read: ${e.code || e.message}`);
          yield { path: rel, unreadable: true, error: e.code || e.message };
          continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) stack.push(r);
          else if (e.isFile()) {
            const st = await fsp.stat(abs(r));
            // on Windows shares the owner comes from ACLs the share does not expose; the uid is kept
            yield { path: r, size: st.size, created: st.birthtime, modified: st.mtime, owner: String(st.uid) };
          }
        }
      }
    },
    stream: (item) => fs.createReadStream(abs(item.path)),
    read: (item) => fsp.readFile(abs(item.path)),
  };
}

module.exports = { localSource };
