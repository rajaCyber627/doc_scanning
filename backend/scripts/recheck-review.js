#!/usr/bin/env node
// Re-check documents waiting in review after rules change (e.g. new document types).
//   node scripts/recheck-review.js [--email user@city.gov | --user-id <id>] [--dry-run]
// 1. Blank / sideways / tilted pages in an otherwise readable multi-page document become
//    notes (they no longer block filing).
// 2. Documents whose type the AI could not tell are classified again (the "General &
//    reference documents" types exist now). Uses one AI call per such document.
require('dotenv').config();
const { connect } = require('../src/core/db');
const File = require('../src/models/File');
const User = require('../src/models/User');
const OcrPage = require('../src/features/ocr/OcrPage.model');
const { splitQuality } = require('../src/features/ocr/quality');
const { runClassification } = require('../src/features/classification/service');
const { getTaxonomy } = require('../src/features/metadata/service');
const events = require('../src/core/events');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const emailArg = argv.includes('--email') ? argv[argv.indexOf('--email') + 1] : null;
const idArg = argv.includes('--user-id') ? argv[argv.indexOf('--user-id') + 1] : null;

(async () => {
  await connect();
  await getTaxonomy(); // adds any new types to the database first
  const q = { status: 'needs_review' };
  if (idArg) q.userId = idArg;
  else if (emailArg) {
    const u = await User.findOne({ email: String(emailArg).toLowerCase() }).select('_id').lean();
    if (!u) throw new Error(`No user ${emailArg}`);
    q.userId = u._id;
  }
  const files = await File.find(q);
  let noted = 0;
  let reclassified = 0;
  for (const f of files) {
    // 1 page notes
    const ocrReasons = (f.reviewReasons || []).filter((r) => r.stage === 'ocr');
    if (ocrReasons.length && (f.pageCount || 0) > 1) {
      const pages = await OcrPage.find({ fileId: f._id }).select('page words').lean();
      const { reviewReasons, notes } = splitQuality(ocrReasons, pages);
      if (notes.length) {
        f.reviewReasons = [...f.reviewReasons.filter((r) => r.stage !== 'ocr'), ...reviewReasons];
        f.notes = [...(f.notes || []), ...notes];
        noted++;
      }
    }
    // 2 type the AI could not tell
    const c = f.classification || {};
    if (c.status === 'suggested' && !(c.suggestion && c.suggestion.documentType)) {
      if (!dry) {
        const upd = (await runClassification(f)) || {};
        Object.assign(f, upd);
      }
      reclassified++;
    }
    if (!dry) {
      if (!(f.reviewReasons || []).length) f.status = 'ready';
      await f.save();
      events.emit('document.changed', String(f._id));
    }
    const s = f.classification && f.classification.suggestion;
    console.log(`  ${f.fileName.slice(0, 60)} → ${f.status}${s && s.documentTypeName ? ` · suggested: ${s.documentTypeName}` : ''}`);
  }
  await events.idle();
  console.log(`${files.length} documents checked · ${noted} got page notes · ${reclassified} classified again${dry ? ' (dry run — nothing saved)' : ''}`);
  process.exit(0);
})().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
