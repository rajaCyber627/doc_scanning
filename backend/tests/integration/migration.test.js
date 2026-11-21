const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { startDb, clearDb, stopDb } = require('../support/helpers');
const fakes = require('../support/fakes/clients');
const { createApp } = require('../../src/app');
const { onIdle } = require('../../src/features/intake/pipeline');
const events = require('../../src/core/events');
const service = require('../../src/features/migration/service');
const { MigrationItem, MigrationLedger } = require('../../src/features/migration/models');
const { sharepointSource } = require('../../src/features/migration/sources/sharepoint');
const { args } = require('../../scripts/migrate');
const User = require('../../src/models/User');
const File = require('../../src/models/File');
const AuditEvent = require('../../src/core/audit/AuditEvent.model');

const app = createApp();
let user;
let admin;
let root;

beforeAll(startDb);
afterAll(stopDb);
beforeEach(async () => {
  await clearDb();
  fakes.__reset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  user = await User.create({ email: 'records@example.com', userName: 'records', password: 'x', permissions: ['restricted'] });
  admin = await User.create({ email: 'admin@example.com', userName: 'admin', password: 'x', permissions: ['admin'] });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrshare-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await onIdle();
    await events.idle();
  }
};

const RULES = {
  rules: [
    {
      name: 'Employee folders',
      pattern: 'Employees/{LastName}_{FirstName}_{EmployeeID}/{Category}/**',
      categories: { Payroll: 'personnel.salary-actions', Benefits: 'benefits.enrollment-documentation', Personnel: 'personnel.other-official-personnel-documents' },
    },
  ],
};
const PEOPLE = [
  ['Smith', 'John', '1045'],
  ['Patel', 'Priya', '2087'],
  ['Rivera', 'Carlos', '3310'],
  ['Doe', 'Jane', '9999'], // not in the HR directory
];
const CATS = ['Payroll', 'Benefits', 'Personnel'];

/** ~50 files: 4 employees × 3 categories × 3 files + duplicates, problems and an unmapped folder. */
function buildTree() {
  const write = (rel, content) => {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  for (const [last, first, id] of PEOPLE)
    for (const cat of CATS)
      for (let n = 1; n <= 3; n++) write(`Employees/${last}_${first}_${id}/${cat}/doc-${n}.txt`, `${cat} record ${n} for ${first} ${last}, employee ${id}. Kept in the City of Portsmouth HR share since 2019.`);
  write('Employees/Smith_John_1045/Payroll/doc-1-copy.txt', `Payroll record 1 for John Smith, employee 1045. Kept in the City of Portsmouth HR share since 2019.`); // duplicate
  write('Employees/Patel_Priya_2087/Benefits/old/doc-2.txt', `Benefits record 2 for Priya Patel, employee 2087. Kept in the City of Portsmouth HR share since 2019.`); // duplicate, deeper
  write('Employees/Smith_John_1045/Misc/notes.txt', 'Misc notes for John Smith, employee 1045, regarding parking and locker assignments at City Hall.'); // category not mapped
  write('Scans/misc/scan-001.txt', 'Unsorted scan from the old copier, contents unknown, possibly a benefits form for an employee.'); // no rule
  write('Scans/misc/setup.exe', 'MZ not really'); // unsupported
  write('Scans/misc/thumbs.db', 'junk'); // unsupported
  write('Scans/misc/empty.pdf', ''); // empty
  write('Scans/misc/broken.pdf', 'this is not a pdf at all'); // damaged
  return 36 + 8;
}
const listing = () => {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : out.push([path.relative(root, path.join(d, e.name)), fs.statSync(path.join(d, e.name)).mtimeMs])));
  walk(root);
  return out.sort();
};

describe('shared drive migration (local folder)', () => {
  test('inventory → dry-run mapping → test → production → reconciliation; every file accounted for; re-running imports nothing', async () => {
    const total = buildTree();
    const before = listing();
    const run = await service.createRun({ name: 'HR share', root, ownerEmail: 'records@example.com' });

    // 1 inventory (read-only)
    const inv = await service.inventory(run._id);
    expect(inv).toMatchObject({ files: total, likelyDuplicates: 2, issues: { unsupported: 2, empty: 1, damaged: 1 } });
    expect(inv.importable).toBe(total - 2 - 4);
    expect(inv.byType.txt.files).toBe(40);
    // the first in walk order is the original, the other its duplicate
    const pair = await MigrationItem.find({ path: { $in: ['Employees/Smith_John_1045/Payroll/doc-1-copy.txt', 'Employees/Smith_John_1045/Payroll/doc-1.txt'] } }).lean();
    const dup = pair.find((x) => x.duplicateOf);
    expect(pair.find((x) => !x.duplicateOf).path).toBe(dup.duplicateOf);
    expect(dup.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, dup.path))).digest('hex'));

    // 2 mapping dry run
    const m = await service.map(run._id, RULES);
    expect(m).toMatchObject({ mapped: 39, unmapped: 1, byRule: { 'Employee folders': 39 } });
    const smith = await MigrationItem.findOne({ path: 'Employees/Smith_John_1045/Payroll/doc-2.txt' }).lean();
    expect(smith.mapping).toMatchObject({ employeeId: '1045', personId: 'emp-1045', personName: 'John Smith', documentType: 'personnel.salary-actions', problems: [] });
    const doe = await MigrationItem.findOne({ path: 'Employees/Doe_Jane_9999/Payroll/doc-1.txt' }).lean();
    expect(doe.mapping.problems).toEqual(['ID 9999 is not in the HR directory']);
    const misc = await MigrationItem.findOne({ path: 'Employees/Smith_John_1045/Misc/notes.txt' }).lean();
    expect(misc.mapping.problems[0]).toMatch(/Folder "Misc" has no document type/);
    const mappingCsv = (await service.report(run._id, 'mapping')).csv;
    expect(mappingCsv).toMatch(/Scans\/misc\/scan-001\.txt,UNMAPPED/);

    // 3a test migration on a subset
    const t = await service.migrate(run._id, { mode: 'test', prefix: 'Employees/Smith_John_1045/Payroll', ratePerSec: 0 });
    expect(t).toMatchObject({ imported: 3, skipped: 1, failed: 0 }); // one of the identical pair is skipped
    await settle();
    // 3b production
    const p = await service.migrate(run._id, { mode: 'production', ratePerSec: 0 });
    expect(p.imported).toBe(inv.importable - 3);
    expect(p.pending).toBe(0);
    await settle();

    const imported = await File.find({ source: 'import' });
    expect(imported).toHaveLength(inv.importable);
    const doc = imported.find((f) => f.metadata.migration.path === 'Employees/Smith_John_1045/Payroll/doc-2.txt');
    expect(doc.metadata.migration).toMatchObject({ source: root, mode: 'test', rule: 'Employee folders', folderValues: { LastName: 'Smith', FirstName: 'John', EmployeeID: '1045', Category: 'Payroll' } });
    expect(doc.metadata.migration.modified).toBeTruthy();
    // the folder's person and type become the suggestion a reviewer confirms (AI off in tests)
    expect(doc.classification.suggestion).toMatchObject({ documentType: 'personnel.salary-actions', person: { match: { personId: 'emp-1045' } } });
    expect(await AuditEvent.countDocuments({ action: 'migration.imported' })).toBe(inv.importable);
    const a = await AuditEvent.findOne({ action: 'migration.imported', documentId: doc._id }).lean();
    expect(a.details.sourcePath).toBe('Employees/Smith_John_1045/Payroll/doc-2.txt');

    // 4 reconciliation with hash verification
    const r = await service.reconcile(run._id);
    expect(r).toMatchObject({ source: total, imported: inv.importable, failed: 0, pending: 0, accountedFor: true, verified: { match: inv.importable, mismatch: 0, missing: 0 } });
    expect(r.skipped).toBe(6);
    expect(r.skippedBy).toMatchObject({ 'Duplicate within the source': 2, 'Empty file': 1 });
    const recon = (await service.report(run._id, 'reconciliation')).csv;
    expect(recon).toMatch(/Every file accounted for,yes/);
    expect(recon).toMatch(/Scans\/misc\/setup\.exe,skipped,Programs and scripts are never imported/);

    // re-running the migration imports nothing new
    expect(await service.migrate(run._id, { mode: 'production', ratePerSec: 0 })).toMatchObject({ imported: 0, pending: 0 });
    // …nor does a brand-new run over the same source
    const again = await service.createRun({ name: 'HR share (again)', root, ownerEmail: 'records@example.com' });
    await service.inventory(again._id);
    const p2 = await service.migrate(again._id, { mode: 'production', ratePerSec: 0 });
    expect(p2.imported).toBe(0);
    expect(await File.countDocuments({ source: 'import' })).toBe(inv.importable);
    expect((await service.reconcile(again._id, { verify: false })).skippedBy['Already imported in an earlier run']).toBe(inv.importable);

    // the source was never touched
    expect(listing()).toEqual(before);
  });

  test('a file changed after the inventory fails safely (re-inventory needed); requireMapping skips unmapped files', async () => {
    buildTree();
    const run = await service.createRun({ name: 'HR share', root, ownerEmail: 'records@example.com' });
    await service.inventory(run._id);
    await service.map(run._id, { ...RULES, requireMapping: true });
    fs.appendFileSync(path.join(root, 'Employees/Patel_Priya_2087/Payroll/doc-1.txt'), ' edited');
    await service.migrate(run._id, { mode: 'production', ratePerSec: 0 });
    const changed = await MigrationItem.findOne({ path: 'Employees/Patel_Priya_2087/Payroll/doc-1.txt' }).lean();
    expect(changed).toMatchObject({ status: 'failed', reason: 'The file changed since the inventory — run the inventory again' });
    expect((await MigrationItem.findOne({ path: 'Scans/misc/scan-001.txt' }).lean()).reason).toBe('No mapping rule matches this path');
    expect(await MigrationLedger.countDocuments({ path: changed.path })).toBe(0);
    await settle();
  });

  test('rate limit slows the run down', async () => {
    fs.mkdirSync(path.join(root, 'a'));
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, 'a', `f${i}.txt`), `unique file number ${i} for the rate limit test, City of Portsmouth`);
    const run = await service.createRun({ name: 'x', root, ownerEmail: 'records@example.com' });
    await service.inventory(run._id);
    const t0 = Date.now();
    await service.migrate(run._id, { mode: 'production', ratePerSec: 20 }); // 4 files at 20/s ≥ ~150 ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    await settle();
  });

  test('validation, admin views and report downloads', async () => {
    await expect(service.createRun({ root, ownerEmail: 'nobody@example.com' })).rejects.toThrow(/--owner/);
    await expect(service.createRun({ ownerEmail: 'records@example.com' })).rejects.toThrow(/--root/);
    buildTree();
    const run = await service.createRun({ name: 'HR share', root, ownerEmail: 'records@example.com' });
    await service.inventory(run._id);
    await expect(service.map(run._id, { rules: [{ pattern: 'Employees/{Nickname}/**' }] })).rejects.toThrow(/unknown name \{Nickname\}/);
    expect((await request(app).get(`/api/migrations?userId=${user._id}`)).status).toBe(403);
    const list = await request(app).get(`/api/migrations?userId=${admin._id}`);
    expect(list.body.map((r) => r.name)).toEqual(['HR share']);
    const one = await request(app).get(`/api/migrations/${run._id}?userId=${admin._id}`);
    expect(one.body.items.pending).toBe(44);
    const csv = await request(app).get(`/api/migrations/${run._id}/inventory.csv?userId=${admin._id}`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toMatch(/Likely duplicates,2/);
    expect(csv.text).toMatch(/Path,Size,Type,Created,Modified,Owner,SHA-256,Problem,Duplicate of/);
    expect((await request(app).get(`/api/migrations/${run._id}/secrets.csv?userId=${admin._id}`)).status).toBe(404);
  });
});

describe('SharePoint source', () => {
  test('walks folders with paging, keeps dates and owner, reads content', async () => {
    const http = {
      post: jest.fn(async () => ({ data: { access_token: 't', expires_in: 3600 } })),
      request: jest.fn(async ({ url }) => {
        const u = url.replace('https://graph.microsoft.com/v1.0', '');
        if (u === '/drives/D1/root:/HR:/children?$top=200')
          return { data: { value: [{ id: 'f1', name: 'Employees', folder: {} }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page' } };
        if (u === '/next-page') return { data: { value: [{ id: 'i0', name: 'policy.pdf', file: {}, size: 10, createdBy: { user: { email: 'hr@city.gov' } }, fileSystemInfo: { createdDateTime: '2019-01-02T00:00:00Z', lastModifiedDateTime: '2020-03-04T00:00:00Z' } }] } };
        if (u === '/drives/D1/root:/HR/Employees:/children?$top=200') return { data: { value: [{ id: 'i1', name: 'w4.pdf', file: {}, size: 5, createdBy: { user: { displayName: 'Pat' } } }] } };
        if (u === '/drives/D1/items/i1/content') return { data: Buffer.from('%PDF-') };
        throw new Error(`unexpected ${u}`);
      }),
    };
    const src = sharepointSource({ tenantId: 'T', clientId: 'C', clientSecret: 'S', driveId: 'D1', folder: '/HR/' }, http);
    const seen = [];
    for await (const e of src.walk()) seen.push(e);
    expect(seen.map((e) => e.path).sort()).toEqual(['Employees/w4.pdf', 'policy.pdf']);
    expect(seen.find((e) => e.path === 'policy.pdf')).toMatchObject({ owner: 'hr@city.gov', created: new Date('2019-01-02T00:00:00Z'), modified: new Date('2020-03-04T00:00:00Z') });
    expect((await src.read(seen.find((e) => e.sourceId === 'i1'))).toString()).toBe('%PDF-');
    expect(src.key).toBe('sharepoint:D1:HR');
    expect(http.post).toHaveBeenCalledTimes(1);
  });
});

test('CLI argument parsing', () => {
  expect(args(['migrate', '--run', 'abc', '--mode', 'test', '--limit', '20', '--no-verify'])).toEqual({ _: ['migrate'], run: 'abc', mode: 'test', limit: '20', 'no-verify': true });
});
