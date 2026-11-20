// AWS Textract OCR (moved verbatim from app.js).
const { textract, BUCKET } = require('../clients');

// ---------------------------------------------------------------------------
// Textract: async document analysis -> raw text + CSV of detected tables
// ---------------------------------------------------------------------------
// mode 'text' -> DetectDocumentText (cheap OCR); mode 'analysis' -> AnalyzeDocument TABLES
function txStart(mode, key) {
  return new Promise((resolve, reject) => {
    const loc = { DocumentLocation: { S3Object: { Bucket: BUCKET, Name: key } } };
    const cb = (err, data) => (err ? reject(err) : resolve(data.JobId));
    if (mode === 'analysis') textract.startDocumentAnalysis({ ...loc, FeatureTypes: ['TABLES'] }, cb);
    else textract.startDocumentTextDetection(loc, cb);
  });
}

function txGet(mode, params) {
  return new Promise((resolve, reject) => {
    const cb = (err, data) => (err ? reject(err) : resolve(data));
    if (mode === 'analysis') textract.getDocumentAnalysis(params, cb);
    else textract.getDocumentTextDetection(params, cb);
  });
}

async function txComplete(mode, jobId) {
  for (;;) {
    const data = await txGet(mode, { JobId: jobId });
    if (data.JobStatus === 'IN_PROGRESS') {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (data.JobStatus === 'SUCCEEDED') return;
    throw new Error('Textract job ' + data.JobStatus + (data.StatusMessage ? ': ' + data.StatusMessage : ''));
  }
}

async function txResults(mode, jobId) {
  const pages = [];
  let token;
  do {
    const data = await txGet(mode, { JobId: jobId, NextToken: token });
    pages.push(data);
    token = data.NextToken;
  } while (token);
  return pages;
}

function cellText(result, blocksMap) {
  let text = '';
  for (const rel of result.Relationships || []) {
    if (rel.Type !== 'CHILD') continue;
    for (const childId of rel.Ids) {
      const w = blocksMap[childId];
      if (!w) continue;
      if (w.BlockType === 'WORD') text += w.Text + ' ';
      if (w.BlockType === 'SELECTION_ELEMENT' && w.SelectionStatus === 'SELECTED') text += 'X ';
    }
  }
  return text.trim();
}

function tableToCsv(tableBlock, blocksMap, index) {
  const rows = {};
  for (const rel of tableBlock.Relationships || []) {
    if (rel.Type !== 'CHILD') continue;
    for (const childId of rel.Ids) {
      const cell = blocksMap[childId];
      if (cell && cell.BlockType === 'CELL') {
        rows[cell.RowIndex] = rows[cell.RowIndex] || {};
        rows[cell.RowIndex][cell.ColumnIndex] = cellText(cell, blocksMap);
      }
    }
  }
  let csv = `Table ${index}\n`;
  for (const cols of Object.values(rows)) {
    csv += Object.values(cols).map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n';
  }
  return csv + '\n';
}

function blocksToTablesCsv(blocks) {
  const blocksMap = {};
  const tableBlocks = [];
  for (const b of blocks) {
    blocksMap[b.Id] = b;
    if (b.BlockType === 'TABLE') tableBlocks.push(b);
  }
  return tableBlocks.map((t, i) => tableToCsv(t, blocksMap, i + 1)).join('');
}

async function runTextractMode(mode, key) {
  const jobId = await txStart(mode, key);
  await txComplete(mode, jobId);
  const pages = await txResults(mode, jobId);
  const lines = [];
  const words = [];
  for (const page of pages) {
    for (const b of page.Blocks || []) {
      if (b.BlockType === 'LINE') lines.push(b.Text);
      else if (b.BlockType === 'WORD' && b.Geometry && b.Geometry.BoundingBox && words.length < 8000) {
        const bb = b.Geometry.BoundingBox;
        words.push({ text: b.Text, page: b.Page || 1, x: bb.Left, y: bb.Top, w: bb.Width, h: bb.Height });
      }
    }
  }
  return { rawText: lines.join('\n'), tablesCsv: '', words };
}

// Prefer cheap OCR (DetectDocumentText). If the IAM role isn't allowed that
// action, fall back to DocumentAnalysis (Tables), which the current policy permits.
async function runTextract(key) {
  try {
    return await runTextractMode('text', key);
  } catch (e) {
    const denied =
      e && (e.code === 'AccessDeniedException' || /not authorized|accessdenied/i.test(e.message || ''));
    if (denied) {
      console.warn('Textract OCR not permitted; falling back to DocumentAnalysis (Tables)');
      return await runTextractMode('analysis', key);
    }
    throw e;
  }
}

module.exports = { runTextract, runTextractMode, blocksToTablesCsv };
