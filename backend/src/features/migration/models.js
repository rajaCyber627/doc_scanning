const mongoose = require('mongoose');

// A migration run: one source (a network folder or a SharePoint library) taken through
// inventory → mapping (dry run) → test / production migration → reconciliation.
const runSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    source: { kind: { type: String, enum: ['local', 'sharepoint'], required: true }, root: String, driveId: String, label: String },
    sourceKey: { type: String, required: true, index: true }, // identifies the source across runs (idempotency)
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // who owns imported documents
    startedBy: { type: String, default: 'cli' },
    status: { type: String, enum: ['created', 'inventoried', 'mapped', 'migrating', 'migrated', 'reconciled', 'failed'], default: 'created' },
    mapping: { type: mongoose.Schema.Types.Mixed, default: null }, // the rules file used for the dry run
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Batch', default: null },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} }, // { inventory, mapping, migration: [...passes], reconciliation }
    error: { type: String, default: '' },
  },
  { timestamps: true, minimize: false } // keep empty {} in summaries (e.g. no failures)
);

// One source file in a run.
const itemSchema = new mongoose.Schema(
  {
    runId: { type: mongoose.Schema.Types.ObjectId, ref: 'MigrationRun', required: true, index: true },
    path: { type: String, required: true }, // relative to the source root, "/"-separated
    sourceId: { type: String, default: '' }, // SharePoint item id
    size: Number,
    ext: String,
    created: Date,
    modified: Date,
    owner: { type: String, default: '' },
    sha256: { type: String, index: true },
    issue: { type: String, default: '' }, // unsupported | empty | damaged | too_large | unreadable
    issueDetail: { type: String, default: '' },
    duplicateOf: { type: String, default: '' }, // earlier path in the source with the same bytes
    mapping: { type: mongoose.Schema.Types.Mixed, default: null }, // { rule, values, employeeId, personId, personName, documentType, category, problems }
    status: { type: String, enum: ['pending', 'imported', 'skipped', 'failed'], default: 'pending', index: true },
    mode: { type: String, default: '' }, // test | production
    reason: { type: String, default: '' },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File', default: null },
    verified: { type: String, default: '' }, // match | mismatch | missing
  },
  { timestamps: true }
);
itemSchema.index({ runId: 1, path: 1 }, { unique: true });

// Everything ever imported from a source, across runs: re-running never imports twice.
const ledgerSchema = new mongoose.Schema(
  {
    sourceKey: { type: String, required: true },
    path: { type: String, required: true },
    sha256: { type: String, required: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File' },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: 'MigrationRun' },
  },
  { timestamps: true }
);
ledgerSchema.index({ sourceKey: 1, path: 1, sha256: 1 }, { unique: true });

module.exports = {
  MigrationRun: mongoose.model('MigrationRun', runSchema),
  MigrationItem: mongoose.model('MigrationItem', itemSchema),
  MigrationLedger: mongoose.model('MigrationLedger', ledgerSchema),
};
