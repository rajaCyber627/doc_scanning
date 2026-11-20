// Rebuild the full-text index (SearchDoc) for every processed document, and hand
// ready documents to the partner. Safe to re-run.
//   node scripts/reindex-search.js            index + hand off
//   node scripts/reindex-search.js --no-sync  index only
require('dotenv').config();
const { connect } = require('../src/core/db');
const File = require('../src/models/File');
const { indexDocument, syncToPartner } = require('../src/features/search/indexer');

(async () => {
  const sync = !process.argv.includes('--no-sync');
  await connect();
  const files = await File.find({ status: { $in: ['ready', 'needs_review'] } }).select('_id fileName').lean();
  let indexed = 0;
  let synced = 0;
  let failed = 0;
  for (const f of files) {
    try {
      if (await indexDocument(f._id)) indexed++;
      if (sync && (await syncToPartner(f._id))) synced++;
    } catch (e) {
      failed++;
      console.error(`  ${f.fileName}: ${e.message}`);
    }
  }
  console.log(`Indexed ${indexed}/${files.length} documents${sync ? `, handed off ${synced}` : ''}${failed ? `, ${failed} failed` : ''}.`);
  process.exit(failed ? 1 : 0);
})();
