const { PDFDocument, StandardFonts } = require('pdf-lib');
const { parsePdf } = require('../../src/features/documents/formats/pdfText');

// Small Buffers share Node's memory pool. pdf.js used to read the whole pool, so small
// PDFs failed at random ("bad XRef entry"). Every read must now succeed.
test('small (pooled) PDF buffers are read reliably', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Alpha one text here', { x: 50, y: 700, size: 10, font });
  const bytes = await doc.save();
  for (let i = 0; i < 8; i++) {
    const pooled = Buffer.from(bytes); // < 4 KB → a slice of the shared pool
    expect(pooled.byteOffset > 0 || pooled.buffer.byteLength > pooled.length).toBe(true);
    const r = await parsePdf(pooled);
    expect(r.text.trim()).toBe('Alpha one text here');
  }
});
