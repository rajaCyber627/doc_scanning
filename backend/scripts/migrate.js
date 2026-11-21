#!/usr/bin/env node
// Import from shared drives (P16) — command line for large migrations.
//
//   node scripts/migrate.js create    --name "HR share" --root /mnt/hr --owner records@city.gov
//   node scripts/migrate.js create    --name "HR SharePoint" --sharepoint --drive <driveId> [--root "Shared Documents/HR"] --owner …
//   node scripts/migrate.js inventory --run <id> [--out inventory.csv]
//   node scripts/migrate.js map       --run <id> --rules rules.json [--out mapping.csv]
//   node scripts/migrate.js migrate   --run <id> --mode test [--limit 20] [--prefix Employees/Smith] [--rate 5]
//   node scripts/migrate.js migrate   --run <id> --mode production [--rate 5]
//   node scripts/migrate.js reconcile --run <id> [--no-verify] [--out reconciliation.csv]
//   node scripts/migrate.js list
//
// Every step can be re-run safely. The source is only read, never changed.
require('dotenv').config();
const fs = require('fs');
const { connect } = require('../src/core/db');
const { onIdle } = require('../src/features/intake/pipeline');
const events = require('../src/core/events');
const service = require('../src/features/migration/service');
const { MigrationRun } = require('../src/features/migration/models');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}
const say = (s) => process.stdout.write(`${s}\n`);
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

async function writeReport(runId, kind, out) {
  if (!out) return;
  const { csv } = await service.report(runId, kind);
  fs.writeFileSync(out, csv);
  say(`  report written to ${out}`);
}
async function drain() {
  // wait for the pipeline (OCR, classification…) of imported documents to finish
  for (let i = 0; i < 3; i++) {
    await onIdle();
    await events.idle();
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (!cmd || a.help) {
    say(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  await connect();
  switch (cmd) {
    case 'create': {
      const run = await service.createRun({ name: a.name, kind: a.sharepoint ? 'sharepoint' : 'local', root: a.root || '', driveId: a.drive || '', ownerEmail: a.owner });
      say(`Created run ${run._id} — ${run.source.label}`);
      say(`Next: node scripts/migrate.js inventory --run ${run._id}`);
      break;
    }
    case 'inventory': {
      say('Walking the source (read-only)…');
      const s = await service.inventory(a.run, { onProgress: (n) => say(`  ${n} files…`) });
      say(`Inventory: ${s.files} files, ${mb(s.bytes)} · importable ${s.importable} · likely duplicates ${s.likelyDuplicates}`);
      for (const [k, v] of Object.entries(s.issues)) say(`  ${k}: ${v}`);
      await writeReport(a.run, 'inventory', a.out);
      break;
    }
    case 'map': {
      if (!a.rules) throw new Error('--rules <file.json> is required');
      const rules = JSON.parse(fs.readFileSync(a.rules, 'utf8'));
      const s = await service.map(a.run, rules);
      say(`Dry run: ${s.mapped} mapped, ${s.unmapped} unmapped, ${s.withProblems} with problems`);
      for (const [k, v] of Object.entries(s.byRule)) say(`  ${k}: ${v}`);
      await writeReport(a.run, 'mapping', a.out);
      break;
    }
    case 'migrate': {
      const mode = a.mode || 'test';
      say(`Migrating (${mode})…`);
      const r = await service.migrate(a.run, { mode, limit: Number(a.limit) || 0, prefix: a.prefix || '', ratePerSec: a.rate, onProgress: (n) => say(`  ${n} files…`) });
      say(`Imported ${r.imported}, skipped ${r.skipped}, failed ${r.failed}; ${r.pending} still to migrate`);
      say('Waiting for the imported documents to finish processing…');
      await drain();
      break;
    }
    case 'reconcile': {
      const r = await service.reconcile(a.run, { verify: !a['no-verify'] });
      say(`Source ${r.source} = imported ${r.imported} + skipped ${r.skipped} + failed ${r.failed} + pending ${r.pending}  →  ${r.accountedFor ? 'every file accounted for' : 'MISMATCH'}`);
      say(`Hash check: ${r.verified.match} match, ${r.verified.mismatch} mismatch, ${r.verified.missing} missing`);
      for (const [k, v] of Object.entries(r.skippedBy)) say(`  skipped — ${k}: ${v}`);
      for (const [k, v] of Object.entries(r.failedBy)) say(`  failed — ${k}: ${v}`);
      await writeReport(a.run, 'reconciliation', a.out);
      break;
    }
    case 'list': {
      for (const r of await MigrationRun.find({}).sort({ createdAt: -1 }).limit(50).lean()) say(`${r._id}  ${r.status.padEnd(11)} ${r.name} — ${r.source.label}`);
      break;
    }
    default:
      throw new Error(`Unknown command "${cmd}" — run with --help`);
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    });
}

module.exports = { args };
