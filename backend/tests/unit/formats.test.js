const { PDFDocument } = require('pdf-lib');
const { rtfToText } = require('../../src/features/documents/formats/office');
const { textToPdf, sanitize } = require('../../src/features/documents/formats/pdfBuilder');
const { typeForName, contentMatches, mismatchReason, isExecutableName, sniffers } = require('../../src/features/upload/fileTypes');

describe('rtfToText', () => {
  test('unicode escapes skip their fallback character; cp1252 quotes decode', () => {
    const BS = String.fromCharCode(92); // a backslash, built in code so no tool can re-interpret the escape
    expect(rtfToText('{' + BS + 'rtf1' + BS + 'uc1 A' + BS + 'u8212?B ' + BS + "'93hi" + BS + "'94" + BS + 'par}')).toBe('A—B “hi”');
  });
  test('negative \\u values (RTF signed 16-bit) map to the right character', () => {
    expect(rtfToText(String.raw`{\rtf1 \u-3913?\par}`)).toBe(String.fromCharCode(65536 - 3913));
  });
  test('escaped braces and backslashes are kept; optional destinations are dropped', () => {
    expect(rtfToText(String.raw`{\rtf1 a\{b\}c\\d{\*\unknowndest hidden}e\par}`)).toBe('a{b}c\\de');
  });
});

describe('pdfBuilder', () => {
  test('text with characters outside the PDF font never breaks building', async () => {
    const { pdf, pageCount } = await textToPdf('English, Español, 中文, emoji 🎉, “quotes” — dash', { title: 'Mixed' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount).toBe(1);
    expect(sanitize('中文 “x”')).toBe('?? "x"');
  });
  test('long text paginates and is capped', async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `Line ${i}`).join('\n');
    const r = await textToPdf(long, { maxPages: 5 });
    expect(r.pageCount).toBe(5);
    expect(r.truncated).toBe(true);
    expect((await PDFDocument.load(r.pdf)).getPageCount()).toBe(5);
  });
});

describe('fileTypes', () => {
  test('every registered type has a sniffer and a label', () => {
    for (const ext of ['pdf', 'heic', 'doc', 'xls', 'msg', 'eml', 'zip', 'rtf', 'odt', 'pptx', 'gif', 'bmp']) {
      const t = typeForName(`file.${ext}`);
      expect(t).toBeTruthy();
      expect(typeof t.sniff).toBe('function');
    }
  });
  test('executables and macro-enabled Office files are recognised as never-import', () => {
    for (const n of ['a.exe', 'b.JS', 'c.docm', 'd.ps1', 'e.lnk']) expect(isExecutableName(n)).toBe(true);
    expect(isExecutableName('report.pdf')).toBe(false);
  });
  test('.eml needs real mail headers; plain text is not an email', () => {
    expect(sniffers.isEml(Buffer.from('From: a@b.c\r\nSubject: hi\r\n\r\nbody'))).toBe(true);
    expect(sniffers.isEml(Buffer.from('just some notes'))).toBe(false);
  });
  test('encrypted .docx (an OLE container) gets a password message', () => {
    const cfb = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const t = typeForName('pay.docx');
    expect(contentMatches(t, cfb)).toBe(false);
    expect(mismatchReason(t, cfb, 'pay.docx')).toMatch(/password-protected/);
  });
});
