// Turn raw Textract blocks (any provider that speaks the Textract format) into a
// provider-neutral result:
//   { pages: [{ page, text, words, lines, confidence, keyValues, tables,
//               handwritingRatio, skewDegrees }], text, tablesCsv, keyValues }
// Boxes are normalized (0–1) relative to the page, like Textract's BoundingBox.

function childIds(block, type = 'CHILD') {
  return (block.Relationships || []).filter((r) => r.Type === type).flatMap((r) => r.Ids);
}

function textOf(block, byId) {
  return childIds(block)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((b) => (b.BlockType === 'WORD' ? b.Text : b.BlockType === 'SELECTION_ELEMENT' && b.SelectionStatus === 'SELECTED' ? 'X' : ''))
    .filter(Boolean)
    .join(' ');
}

// Angle (degrees) of a line from its top edge (Polygon points 0 → 1).
function lineAngle(b) {
  const p = b.Geometry && b.Geometry.Polygon;
  if (!p || p.length < 2) return null;
  const dx = p[1].X - p[0].X;
  const dy = p[1].Y - p[0].Y;
  if (Math.abs(dx) + Math.abs(dy) < 1e-6) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const box = (b) => {
  const bb = (b.Geometry && b.Geometry.BoundingBox) || {};
  return { x: bb.Left || 0, y: bb.Top || 0, w: bb.Width || 0, h: bb.Height || 0 };
};

function tableRows(table, byId) {
  const rows = [];
  for (const id of childIds(table)) {
    const cell = byId.get(id);
    if (!cell || cell.BlockType !== 'CELL') continue;
    const r = (cell.RowIndex || 1) - 1;
    const c = (cell.ColumnIndex || 1) - 1;
    rows[r] = rows[r] || [];
    rows[r][c] = textOf(cell, byId);
  }
  return rows.map((r) => Array.from(r || [], (v) => v || ''));
}

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;

function normalizeBlocks(blocks) {
  const byId = new Map(blocks.map((b) => [b.Id, b]));
  const pages = new Map();
  const pageOf = (b) => {
    const n = b.Page || 1;
    if (!pages.has(n)) pages.set(n, { page: n, lines: [], words: [], keyValues: [], tables: [], angles: [] });
    return pages.get(n);
  };
  for (const b of blocks) if (b.BlockType === 'PAGE') pageOf(b);

  for (const b of blocks) {
    if (b.BlockType === 'LINE') {
      const pg = pageOf(b);
      pg.lines.push({ text: b.Text || '', confidence: b.Confidence ?? null, ...box(b) });
      const a = lineAngle(b);
      if (a !== null) pg.angles.push(a);
    } else if (b.BlockType === 'WORD') {
      pageOf(b).words.push({
        t: b.Text || '',
        c: b.Confidence ?? null,
        hw: b.TextType === 'HANDWRITING' ? 1 : 0,
        ...box(b),
      });
    } else if (b.BlockType === 'KEY_VALUE_SET' && (b.EntityTypes || []).includes('KEY')) {
      const valueBlock = childIds(b, 'VALUE').map((id) => byId.get(id)).find(Boolean);
      const key = textOf(b, byId).replace(/[:\s]+$/, '');
      if (key) {
        pageOf(b).keyValues.push({
          key,
          value: valueBlock ? textOf(valueBlock, byId) : '',
          confidence: Math.min(b.Confidence ?? 100, (valueBlock && valueBlock.Confidence) ?? 100),
        });
      }
    } else if (b.BlockType === 'TABLE') {
      pageOf(b).tables.push({ rows: tableRows(b, byId) });
    }
  }

  const out = [...pages.values()].sort((a, b) => a.page - b.page).map((pg) => {
    const confs = pg.words.map((w) => w.c).filter((c) => typeof c === 'number');
    const hw = pg.words.filter((w) => w.hw).length;
    return {
      page: pg.page,
      text: pg.lines.map((l) => l.text).join('\n'),
      lines: pg.lines,
      words: pg.words,
      confidence: confs.length ? Math.round((confs.reduce((s, c) => s + c, 0) / confs.length) * 10) / 10 : null,
      handwritingRatio: pg.words.length ? Math.round((hw / pg.words.length) * 100) / 100 : 0,
      skewDegrees: Math.round(median(pg.angles) * 10) / 10,
      keyValues: pg.keyValues,
      tables: pg.tables,
    };
  });

  let tableNo = 0;
  const tablesCsv = out
    .flatMap((pg) => pg.tables.map((t) => `Table ${++tableNo} (page ${pg.page})\n${t.rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`))
    .join('\n');
  return {
    pages: out,
    text: out.map((p) => p.text).join('\n\n'),
    tablesCsv,
    keyValues: out.flatMap((p) => p.keyValues.map((kv) => ({ ...kv, page: p.page }))),
  };
}

module.exports = { normalizeBlocks };
