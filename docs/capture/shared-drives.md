# Import from shared drives (RFP capture feature: "import from shared drives")

This is a safe, repeatable tool for moving the City's existing HR network folders and SharePoint
libraries into the system. Its steps follow the RFP's **Data Migration** section (pp. 15-16):

| RFP step | Tool step |
|---|---|
| Discovery, inventory | `inventory`: read-only walk, inventory report |
| Mapping, metadata mapping | `map`: rules file, dry run, unmapped / problem list |
| Cleansing recommendations, duplicate identification | Inventory problems (unsupported, empty, damaged, too large) and likely duplicates. Cross-system duplicates use P08 |
| Test migration | `migrate --mode test` on a subset (`--limit`, `--prefix`) |
| Production migration | `migrate --mode production` (resumable, rate-limited, idempotent) |
| Validation, reconciliation, exception reporting | `reconcile`: counts, reasons, hash verification, reconciliation report |

**The source is never modified.** Files are only listed, hashed and read: nothing is renamed,
moved or deleted.

## Sources (one interface)

| Source | How | Kept as metadata |
|---|---|---|
| **Network folder** | The SMB share mounted on the machine running the tool (`--root /mnt/hr`) | path, created / modified dates, owner (uid; Windows shares do not expose ACL owners through a mount) |
| **SharePoint / OneDrive** | Microsoft Graph, a document library = drive (`--sharepoint --drive <id> --root "HR"`) | path, created / modified dates (`fileSystemInfo`), owner (`createdBy`) |

For SharePoint, register an app with **`Sites.Selected`** (application) and grant it **read**
on the HR site only:
`POST /sites/{site-id}/permissions { roles: ["read"], grantedToIdentities: [{ application: { id, displayName } }] }`.
It reuses `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET`, the same pattern as email
intake (see `email.md`).

## The steps (CLI)

```
cd backend
node scripts/migrate.js create    --name "HR share" --root /mnt/hr --owner records@portsmouthva.gov
node scripts/migrate.js inventory --run <id> --out inventory.csv
node scripts/migrate.js map       --run <id> --rules rules.json --out mapping.csv
node scripts/migrate.js migrate   --run <id> --mode test --limit 20          # or --prefix "Employees/Smith_John_1045"
node scripts/migrate.js migrate   --run <id> --mode production --rate 5
node scripts/migrate.js reconcile --run <id> --out reconciliation.csv
node scripts/migrate.js list
```

Every step can be re-run.

### 1. Inventory (read-only)

For each file it records the path, size, type, dates, owner and **SHA-256**. It flags
**unsupported** types (programs, `thumbs.db`, unknown extensions), **empty** files, **damaged**
files (content does not match the extension), files **too large** for the upload limit, and
unreadable folders. **Likely duplicates** are files with identical bytes elsewhere in the source;
the first in path order is kept.

The summary gives counts and bytes **by type**, files **by age** (under 1 / 1–3 / 3–7 / over 7
years since last change, useful for retention decisions), problems, duplicates and the importable
total. `inventory.csv` contains the summary plus one row per file.

### 2. Mapping rules (dry run)

A JSON rules file maps folder patterns to person and metadata:

```json
{
  "rules": [
    {
      "name": "Employee folders",
      "pattern": "Employees/{LastName}_{FirstName}_{EmployeeID}/{Category}/**",
      "categories": {
        "Payroll": "personnel.salary-actions",
        "Benefits": "benefits.enrollment-documentation",
        "Personnel": "personnel.other-official-personnel-documents"
      }
    },
    { "name": "Applicants", "pattern": "Recruitment/{Year}/{ApplicantNumber}_{FullName}/**" }
  ],
  "requireMapping": false
}
```

Pattern syntax:
- `{Name}` matches part of one folder or file name. Known names: `EmployeeID`, `ApplicantNumber`,
  `LastName`, `FirstName`, `FullName`, `Category`, `DocumentType`, `Year`.
- `*` matches one folder; `**` matches any depth.
- Matching is case-insensitive, and `\` works too. The first matching rule wins.

What the dry run does with a match:
- **Employee / applicant numbers** are checked against the HR directory (`PartnerAdapter`).
- **Categories** map to taxonomy document types.
- **Problems** are listed per file: unknown ID, folder name different from the directory, category
  without a type, unknown type.
- `mapping.csv` shows how every file would be mapped, with **UNMAPPED** rows for files no rule
  matches.
- `requireMapping: true` makes migration skip unmapped files. By default they are imported and
  classified like any upload.

### 3. Test and production migration

- Each importable file is read, its hash re-checked against the inventory (a changed file fails
  with "run the inventory again"), stored, and created as a document (`source = import`). It then
  runs the **normal pipeline**: formats (P05), OCR (P06), duplicate check against everything
  already in the system (P08), and classification (P10).
- The mapped person and type become the classification **suggestion**, which a reviewer confirms
  (`File.prefill`). They are never filed unreviewed.
- `metadata.migration` keeps the original **path, created / modified dates, owner**, the run, the
  mode (test / production) and the folder values.
- **Idempotent**: a ledger keyed on source + path + SHA-256 is claimed atomically before the
  document is created. Re-running a pass, a production pass after a test pass, or a brand-new run
  over the same source never imports the same file twice ("Already imported in an earlier run").
- **Resumable**: each file's state is saved as it goes, so an interrupted pass continues with what
  is still pending. Documents that were mid-pipeline resume when the server restarts. Documents
  that failed (e.g. a network outage) are retried from the run's batch (**Retry failed**).
- **Rate-limited**: `--rate` files per second (default `MIGRATION_RATE_PER_SEC=5`, 0 = no limit),
  to protect the file server, the OCR quota and the AI quota.
- All imports of a run go into one batch, "Import · run name", for progress tracking.
- Audit: `migration.imported` per file `{ runId, sourcePath, source, mode }`, plus
  `migration.created`, `inventoried`, `mapped`, `started`, `pass_completed`, `reconciled` and
  `report_generated`.

### 4. Reconciliation and exceptions

**Files in source = imported + skipped + failed + not yet migrated.** "Every file accounted for"
is checked explicitly.

- **Skipped, with reasons**: duplicate within the source, already imported, unsupported, empty,
  damaged, too large, unmapped (when required).
- **Failed, with reasons.**
- **Pipeline outcome** of the imported documents.
- **Post-migration verification**: each imported document's stored bytes are re-hashed and
  compared with the inventory hash (match / mismatch / missing).

`reconciliation.csv` contains the summary plus one row per file: outcome, reason, mode, document
id, hash check.

## Admin page

**Migrations** (admin menu) lists runs. Opening a run shows the four steps:
- inventory figures
- mapping counts and unmapped paths
- each migration pass
- reconciliation, with "every file accounted for" and the hash check

Each report downloads as CSV. Runs are started from the CLI, because large migrations take hours
and must survive closed browsers.

## Code

`backend/src/features/migration/`:
- `sources/local.js`, `sources/sharepoint.js`
- `mapping.js`
- `service.js`
- `models.js` (MigrationRun, MigrationItem, MigrationLedger)
- `routes.js`

Also:
- `backend/scripts/migrate.js`
- client `features/migration/MigrationsPage.tsx`
- generic `File.prefill`, read by classification

## Tests

`backend/tests/integration/migration.test.js` covers:

- **the acceptance case**: a 44-file fixture tree (employee naming pattern, 2 duplicates,
  unsupported / empty / damaged files, unknown ID, unmapped folder) produces:
  - inventory figures
  - dry-run mapping (39 mapped, 1 unmapped, problems listed)
  - a test pass on a subset, then production
  - reconciliation: every file accounted for, all hashes match, skip reasons
- re-running the pass and a new run over the same source import nothing; the source tree is
  byte- and time-identical afterwards
- a file changed after the inventory fails safely; `requireMapping` skips unmapped files
- the rate limit
- validation, admin-only views and report downloads
- SharePoint walk with paging, dates, owner and content
- CLI arguments

Client: `MigrationsPage.test.tsx`.

**Live CLI run** (real database and S3, 41-file share):
- inventory: 37 importable, 1 duplicate, 1 unsupported, 1 empty, 1 damaged
- dry run: 37 mapped, 1 unmapped
- test pass: 5; production pass: 32 imported, 4 skipped
- reconciliation: **41 = 37 + 4 + 0 + 0, every file accounted for; 37 / 37 hashes match**
- re-run: 0 imported

The machine's network dropped during that run. 3 documents failed in the pipeline and 7 were left
mid-pipeline when the CLI was stopped. A server restart resumed the 7, **Retry failed** recovered
the 3, and all 37 ended up waiting for review.
