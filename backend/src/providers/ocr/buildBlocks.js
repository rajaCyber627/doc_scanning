// Build Textract-format blocks from a simple description. Used to create OCR
// fixtures (development while Textract is inactive) and in tests.
//
// buildBlocks([{ lines: [{ text, conf=99, handwriting=false, angle=0 }],
//               keyValues: [[key, value]], tables: [[[cell, ...], ...]] }])
let seq = 0;
const id = () => `b${++seq}`;

function polygon(x, y, w, h, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a) * w;
  const dy = Math.sin(a) * w;
  return [
    { X: x, Y: y },
    { X: x + dx, Y: y + dy },
    { X: x + dx, Y: y + dy + h },
    { X: x, Y: y + h },
  ];
}

function buildBlocks(pages) {
  const blocks = [];
  pages.forEach((pg, pi) => {
    const Page = pi + 1;
    const pageBlock = { Id: id(), BlockType: 'PAGE', Page, Relationships: [{ Type: 'CHILD', Ids: [] }] };
    blocks.push(pageBlock);
    (pg.lines || []).forEach((ln, li) => {
      const y = 0.05 + li * 0.04;
      const words = String(ln.text).split(/\s+/).filter(Boolean);
      const wordIds = [];
      let x = 0.08;
      for (const w of words) {
        const width = Math.max(0.02, w.length * 0.012);
        const wid = id();
        wordIds.push(wid);
        blocks.push({
          Id: wid,
          BlockType: 'WORD',
          Page,
          Text: w,
          Confidence: ln.conf ?? 99,
          TextType: ln.handwriting ? 'HANDWRITING' : 'PRINTED',
          Geometry: { BoundingBox: { Left: x, Top: y, Width: width, Height: 0.025 }, Polygon: polygon(x, y, width, 0.025, ln.angle || 0) },
        });
        x += width + 0.01;
      }
      const lid = id();
      pageBlock.Relationships[0].Ids.push(lid);
      blocks.push({
        Id: lid,
        BlockType: 'LINE',
        Page,
        Text: ln.text,
        Confidence: ln.conf ?? 99,
        Geometry: { BoundingBox: { Left: 0.08, Top: y, Width: x - 0.08, Height: 0.025 }, Polygon: polygon(0.08, y, x - 0.08, 0.025, ln.angle || 0) },
        Relationships: [{ Type: 'CHILD', Ids: wordIds }],
      });
    });
    const wordBlock = (text) => {
      const wid = id();
      blocks.push({ Id: wid, BlockType: 'WORD', Page, Text: text, Confidence: 99, Geometry: { BoundingBox: { Left: 0, Top: 0, Width: 0, Height: 0 } } });
      return wid;
    };
    (pg.keyValues || []).forEach(([k, v]) => {
      const valueId = id();
      blocks.push({
        Id: valueId,
        BlockType: 'KEY_VALUE_SET',
        EntityTypes: ['VALUE'],
        Page,
        Confidence: 95,
        Relationships: [{ Type: 'CHILD', Ids: String(v).split(/\s+/).filter(Boolean).map(wordBlock) }],
      });
      blocks.push({
        Id: id(),
        BlockType: 'KEY_VALUE_SET',
        EntityTypes: ['KEY'],
        Page,
        Confidence: 96,
        Relationships: [
          { Type: 'VALUE', Ids: [valueId] },
          { Type: 'CHILD', Ids: String(k).split(/\s+/).filter(Boolean).map(wordBlock) },
        ],
      });
    });
    (pg.tables || []).forEach((rows) => {
      const cellIds = [];
      rows.forEach((row, r) =>
        row.forEach((cell, c) => {
          const cid = id();
          cellIds.push(cid);
          blocks.push({
            Id: cid,
            BlockType: 'CELL',
            Page,
            RowIndex: r + 1,
            ColumnIndex: c + 1,
            Relationships: [{ Type: 'CHILD', Ids: String(cell).split(/\s+/).filter(Boolean).map(wordBlock) }],
          });
        })
      );
      blocks.push({ Id: id(), BlockType: 'TABLE', Page, Relationships: [{ Type: 'CHILD', Ids: cellIds }] });
    });
  });
  return blocks;
}

module.exports = { buildBlocks };
