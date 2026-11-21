# Capture Hub — Shared Context

Read this before every task in `docs/capture/PROMPTS.md`. It is the single source of
truth for scope, rules and current state. Update the **Progress** section when a task
finishes.

Source: RFP #340-27-YE, City of Portsmouth (VA), *Document Management System for Human
Resources* (issued Oct 27, 2026; proposals due Thu Dec 3, 2026, 2:00 p.m. EST).

---

## 1. Scope (what we build)

Only the RFP section **"Document Capture and Scanning"** (RFP p. 9):

| # | Feature | Prompt |
|---|---------|--------|
| 1 | Individual document upload | P02 |
| 2 | Bulk document upload | P03 |
| 3 | Drag-and-drop functionality | P04 |
| 4 | Scanning | P13 |
| 5 | Batch scanning | P14 |
| 6 | Optical character recognition (OCR) | P06 |
| 7 | Full-text indexing | P07 |
| 8 | Email capture | P15 |
| 9 | Electronic document import | P05 |
| 10 | Import from shared drives | P16 |
| 11 | Automated or assisted classification | P10 |
| 12 | Metadata entry | P09 |
| 13 | Document splitting | P11 |
| 14 | Document merging | P12 |
| 15 | Duplicate detection where available | P08 |
| 16 | Written method for converting paper personnel records | P17 |

## 2. Out of scope (owned by the partner HRDMS)

The partner vendor's system is the **system of record**. It owns: security/access
matrix, electronic personnel-file view, search UI, workflow automation, records
retention / holds / disposition, audit-log storage, version store, reporting and
dashboards, employee/manager self-service. **We only integrate with these.**

## 3. Architecture

```
 INTAKE CHANNELS                CAPTURE HUB PIPELINE (ours)                 PARTNER HRDMS
 ───────────────                ───────────────────────────                 ─────────────
 Upload / bulk / drag-drop ─┐
 Camera / scanner          ─┤   1 store original (S3, encrypted, temporary)
 Batch scanning            ─┤   2 hash → duplicate check
 Outlook shared mailbox    ─┼─▶ 3 extract text / OCR → searchable PDF
 Shared drives / SharePoint─┤   4 split suggestion (multi-document files)    ──▶  push document
 Other formats (.doc, .msg)─┘   5 classify: type, category, confidentiality,       + metadata
                                  person, metadata (with confidence)               + audit events
                                6 review queue (restricted queue separate)
                                7 index → hand-off → purge our copy
```

## 4. Partner hand-off

The partner's API is **not known yet**. All hand-off goes through a `PartnerAdapter`
interface; no feature may call the partner directly.

```
PartnerAdapter
  pushDocument(document, files, metadata, indexPayload) → partnerDocumentId
  pushAuditEvent(event)
  findByHash(sha256) → match | null
  lookupPerson(query) → [{ personId, type: employee|applicant|retiree, name,
                           employeeId, applicantNumber, positionTitle,
                           department, division, status }]
```

`MockPartnerAdapter` is used locally: logs pushes, stores them in a local collection,
and serves people from a seed file.

## 5. Domain rules from the RFP

**Record subjects:** active employees, applicants, retirees, and others HR keeps
official records for (p. 5).

**Record categories and document types (pp. 5–8):**

| Category | Document types |
|---|---|
| 1. Personnel | employment applications and related documents; offer letters; personnel agreements; job changes; promotions; transfers; demotions; salary actions; classification actions; position changes; employee acknowledgements; separation documentation; other official personnel documents |
| 2. Benefits | enrollment documentation; benefit elections; supporting eligibility documentation; retirement-related documentation; beneficiary information; benefit correspondence; qualifying life event documentation |
| 3. Medical & Confidential **(restricted)** | medical certifications; medical documentation; fitness-for-duty records; return-to-work documentation; other confidential medical information |
| 4. FMLA & Leave **(restricted)** | FMLA requests; eligibility notices; medical certifications; designation notices; leave documentation; leave tracking records; return-to-work documentation; leave-related correspondence |
| 5. ADA & Accommodation **(restricted)** | accommodation requests; interactive-process documentation; medical documentation; accommodation decisions; related correspondence |
| 6. Workers' Compensation **(restricted)** | incident documentation; first reports of injury; medical documentation; claim correspondence; return-to-work records; claim status documents; related reports |
| 7. Employee Relations **(investigations & grievances restricted)** | complaints; counseling documentation; disciplinary actions; investigations; grievances; performance-related documentation; employee statements; management responses; supporting evidence; final determinations |
| 8. Recruitment | applications; resumes; interview documentation; selection documentation; offer documentation; background-related records where permitted; recruitment correspondence |
| 9. Classification & Compensation | classification studies; compensation analyses; salary reviews; job descriptions; position documentation; pay actions; supporting approvals |
| 10. Training & Development | training completions; certifications; required training; career development documentation; professional development records |

**Metadata fields (pp. 9–10):** employee name, employee ID, position title,
department, division, document type, HR functional area, effective date, creation
date, fiscal year, record category, retention category, confidentiality level,
status, case number, applicant number, position number, other configurable fields.

**Restricted records (pp. 6, 8–9):** medical, FMLA, ADA, workers' compensation,
employee-relations investigations, grievances, other specially restricted records.
- Medical records are kept separate from general personnel records.
- Access to general personnel records never implies access to restricted records.
- Users without access must not see restricted documents **or learn they exist**
  (no counts, snippets or duplicate details) — p. 10.
- Least-privilege access throughout.

**Integrity rules:**
- Splitting/merging preserves originals (version control, p. 14).
- Every capture action emits an audit event: user, action, document, date, time
  (pp. 13–14). Audit events are not editable by standard users.
- A merge never lowers confidentiality: the result takes the strictest level.

**AI rules (pp. 17–18):** AI features must be disclosed, optional (admin off switch,
everything works without them), human-reviewed, accuracy-tracked and audited. City
data must not be used to train models.

**City environment (pp. 14–15):** Microsoft 365, Outlook, Teams, SharePoint, Microsoft
Entra ID / Active Directory.

## 6. Current state of DocP

**Since P01** the backend is modular, organized as **core / providers / models / features**:

```
backend/
  app.js                      entry: connect DB → recoverStuck() → listen
  scripts/                    one-off scripts (backfill-embeddings, migrate-hash-passwords)
  src/
    app.js                    createApp(): mounts every features/<name>/routes.js (no DB/listen)
    core/                     shared plumbing — no HR/business logic
      config.js               env, model IDs (config.models.main/.fast), pipeline settings
      db.js                   connect()
      queue.js                InProcessQueue (swap for SQS later; same add()/onIdle())
      errors.js               humanizeError() → { code, message, retryable }
      audit/                  emitAudit() + AuditEvent.model (append-only, forwarded to partner)
    providers/                outside services, each behind a small module (+ client.js tests fake)
      storage/                S3 client + s3GetBuffer
      ocr/                    Textract client + runTextract
      llm/                    Anthropic client
      embeddings/             Voyage (embed, embedBatch)
      email/                  SMTP (OTP / notices)
      partner/                PartnerAdapter, MockPartnerAdapter, MockPartnerRecord.model, seed-people.json
    models/                   shared records only: File, User, Folder, Batch
    features/                 one folder per feature: routes.js + its logic + its own models
      auth/  prompts/  documents/ (CRUD, extraction, overview)  intake/ (pipeline, runner, stages)
      folders/  tables/  search/  query/ (answering, semanticIndex, Chunk.model)
  tests/
    unit/  integration/       `npm test`, `npm run test:unit`, `npm run test:integration`
    support/                  setupEnv, mockProviders (global fakes), helpers, fakes/, fixtures/
```

**Dependency rules:** `features → core, providers, models`; `providers → core`;
`core/audit → providers/partner`; nothing imports a feature except `src/app.js` and
another feature's public module (e.g. `intake/stages` uses `documents/extraction`).
**New feature = new folder** under `src/features/` with `routes.js`, then add its name
to `FEATURES` in `src/app.js`. **New outside service = new folder** under
`src/providers/` with a `client.js` (faked in `tests/support/mockProviders.js`).
Pipeline stages: blocking stages must pass before `status: 'ready'`; non-blocking failures are
audited (`pipeline.stage_failed`) but don't fail the document. Non-retryable errors (e.g.
`OCR_NOT_ACTIVATED`) fail on the first attempt with a readable `error` + `errorCode`.
Audit actions so far: `document.uploaded`, `document.ready`, `document.updated`,
`document.deleted`, `folder.deleted`, `pipeline.failed`, `pipeline.stage_failed`.

Original pre-P01 references (line numbers now refer to the old file, kept for history):

| Area | Where | Notes |
|---|---|---|
| AWS clients | `backend/app.js:34-52` | S3, Textract (v2 SDK, end-of-support), Anthropic |
| Upload route | `backend/app.js:624` `POST /api/files` | multer in-memory, `upload.array('files', 20)`; multi-file request creates a Folder |
| Upload size limit | `backend/app.js:439` | multer 25 MB; Vercel proxy limits real uploads to ~4.5 MB |
| Client upload | `client/src/api.ts:113` `uploadOne` | one file per request |
| Extraction | `backend/app.js:276` `extractContent` | docx → mammoth; txt/md/csv → raw; PDF text layer if ≥100 chars/page; else Textract |
| OCR | `backend/app.js:233` `runTextractMode`, `:253` `runTextract` | DetectDocumentText, falls back to AnalyzeDocument TABLES on AccessDenied |
| OCR gaps | `backend/app.js:242`, `:223` | word geometry capped at 8,000 words; `blocksToTablesCsv` unused (tables discarded); confidence ignored |
| Processing | `backend/app.js:317` `processFile` | fire-and-forget after upload: extract → overview (Claude) → status `ready`/`failed` → embed |
| Search | `backend/app.js:690` `GET /api/search` | regex scan of `rawText` |
| File model | `backend/File.js` | userId, folderId, fileName, s3Key, mimeType, status (processing/ready/failed), rawText, tablesCsv, summary, keyFacts, suggestedQuestions, tags, words, error |
| Folder model | `backend/Folder.js` | userId, name |
| User model | `backend/userModel.js` | name, userName, email, password (bcrypt), role (unused), 2FA, customInstructions |
| Accepted types | `client/src/pages/Documents.tsx:146,264`, `client/src/pages/FolderPage.tsx:118` | duplicated list: pdf, png, jpg, jpeg, tif, tiff, docx, txt, md, csv |
| Auth | — | no tokens; client stores user in localStorage and sends `userId` |
| Tests | — | none |

## 7. Known environment limits

- **AWS Textract is not activated** on the dev AWS account (`SubscriptionRequiredException`).
  Images and scanned PDFs fail until it is activated. Build OCR behind an interface
  with a fixture provider so it is testable without Textract.
- **Local MongoDB** (`127.0.0.1:27017/docp`) has **no Atlas Vector Search**.
- S3 bucket `cybernirvana-docs-dev` (us-east-1): upload/read/delete work; the dev IAM
  user cannot call `s3:GetBucketLocation` (not needed).
- AWS SDK v2 is end-of-support; migrating to v3 is acceptable when touching that code.

## 8. Known bugs

- ~~Login without username matched the first user~~ — **fixed in P01** (400 when missing);
  the same pattern in sign-up (missing userName collided with every user) also fixed.
- ~~Opaque failures~~ — **fixed in P02**: `DocumentStatus` shows the stage, the readable
  reason and a Retry button.
- **No real authorization yet:** routes trust `userId` from the request, and
  `GET /api/files`, `/api/tables`, `/api/folders`, `/api/prompts` return **all users' data
  when `userId` is omitted**. Addressed with Entra ID SSO + roles (supporting work, not P01).

## 9. Working rules (every task)

1. Read this file and the relevant code before changing anything.
2. For non-trivial tasks, present a short plan (files, data changes, risks) and
   **wait for approval** before editing.
3. Keep existing features working. No unrelated refactors.
4. Follow the layout and dependency rules in §6: feature code in
   `backend/src/features/<feature>/`, outside services in `backend/src/providers/`,
   shared plumbing in `backend/src/core/`. Tests go in `backend/tests/unit` or
   `backend/tests/integration`. Work on branch `feature/capture-hub`.
5. Add or update tests for new logic; run them and report results honestly,
   including failures.
6. Every capture action emits an audit event; respect the restricted-record rules
   in §5 in every API response and UI.
7. External services (partner, Textract, LLM, Microsoft Graph) are always behind an
   interface with a local mock/fixture implementation.
8. Never commit. Never print secrets from `backend/.env`. Keep `MONGO_URI` pointed at
   a local or dev database — never the live one.
9. Finish with: summary of changes, how to test manually, open questions, and an
   update to **Progress** below.

## 10. Progress

- [x] P00 Shared context file
- [x] P01 Pipeline foundation & test harness (29 tests passing; live end-to-end run unchanged)
- [x] P02 Individual upload (direct-to-S3) — `features/upload` (sessions, presigned single +
  multipart, server proxy fallback, content sniffing, abort), `features/intake/routes` (retry),
  client `features/upload` (queue, tray, progress) + `features/intake/DocumentStatus`;
  long text capped on the record with full text in S3. See `docs/capture/uploads.md`.
  Bucket CORS for browser uploads is NOT set yet (client falls back to proxy).
- [x] P03 Bulk upload & batches — `features/batches` (Batch records the selected-file list up
  front → unfinished files survive a refresh; per-item state; close/complete via
  `core/events` 'batch.touch'; retry failed; cancel unfinished; CSV report with formula
  neutralising), client Batches + Batch pages, folder upload, 4 concurrent uploads, part
  retries. File status gains `needs_review` (set by later stages). Batch ≠ folder: batch is
  intake tracking, folder is organization.
- [x] P04 Drag-and-drop — client `features/upload/DropZone` (page-wide drops with visual overlay, nested
  targets via `useDropTarget` e.g. folder rows, folder drops with paths, up-front rejection with
  reasons, OS clutter skipped, keyboard-accessible `BrowseButtons`, rules from the server even for
  very early drops). Used on Documents, Set and Batch pages (batch page: drop = resume).
  Client component tests: `npx react-scripts test` (6 tests).
- [x] P05 Electronic document import — 23 types (see `docs/capture/formats.md`): readers in
  `features/documents/formats/` (office, email, archive, images, zipSafety, pdfBuilder);
  emails/ZIPs create linked child documents (`documents/children.js`, parentDocumentId,
  containerDepth, childSummary); new non-blocking `render` stage → PDF view
  (`renditionS3Key`, LibreOffice if installed else text PDF); HEIC/GIF/BMP converted to JPEG
  (`ocrSourceS3Key`) for OCR + display; zip-bomb/password/executable protections;
  `UserFacingError` in core/errors for pre-worded failures. Client: PDF view for new formats,
  original download link, Related documents sidebar.
- [x] P06 OCR — `providers/ocr` (textract with FORMS+TABLES and text fallback, fixture provider,
  `normalize.js`, `buildBlocks.js`), `features/ocr` (service, OcrPage per-page storage — no word cap,
  quality reasons, EXIF upright + straighten-and-reread for single images, searchable PDF). Generic
  `File.reviewReasons` → runner sets `needs_review`; `POST /api/files/:id/review` resolves (history in
  `resolvedReviewReasons`). needs_review docs are openable/askable/searchable. See `docs/capture/ocr.md`.
- [x] P07 Full-text indexing — `models/SearchDoc` (normalized text + page offsets + language +
  access fields), `features/search/indexer` (indexDocument, syncToPartner, payload v1; listens to
  `document.changed`), `providers/search` (mongo text search w/ phrases, exclusions, substring
  fallback, safe highlight ranges; atlas stub), `core/access` (viewerFor, visibilityFilter;
  `User.permissions` contains "restricted"). Partner payload schema:
  `docs/capture/partner-payload.schema.json` (validated in tests with ajv). Handoff only when status
  is ready. `scripts/reindex-search.js`. See `docs/capture/search.md`.
- [x] P08 Duplicate detection — `features/duplicates` (fingerprint: contentHash, 64-value MinHash +
  16 LSH bands, numberTokens guard for templated HR forms; service: checkDuplicates in new blocking
  `dedupe` stage, earlier doc = original, partner findByHash, restricted-safe messages; decisions
  keep_both / replace (supersededBy/supersedes, hidden from lists+search, payload
  supersedesDocumentId) / discard; batch bulk decision). Review endpoint refuses while a duplicate
  decision is open. `GET /api/files/:id/preview`. Client DuplicatePanel (+ compare modal), batch
  bulk actions. See `docs/capture/duplicates.md`.
- [x] P09 Metadata entry — `features/metadata` (taxonomy models RecordCategory/DocumentType seeded
  from `seed-taxonomy.json`: 10 categories, 74 types; base fields in `fields.js`; service normalize/
  validate/applyMetadata with per-field audit, bulk preview/apply, next-incomplete, admin type save +
  JSON import/export; person verified via `PartnerAdapter.getPerson`). File gains metadataStatus/
  metadataErrors; confidentialityLevel → File.confidentiality. Handoff gated on metadataStatus
  complete. `core/access` viewer.isAdmin. Client MetadataPanel (+PersonPicker, shortcuts),
  BulkEditModal, TaxonomyPage (admin nav). See `docs/capture/metadata.md`.
- [x] P10 Automated / assisted classification — `features/classification` (classifier: claude-opus-5-5
  structured JSON output, taxonomy in a cached system prompt, page-marked text, one retry; service:
  runClassification in the `classify` stage, person match by ID > name, restricted-first routing,
  review queues general/restricted, accept/reassign, admin settings in `models/Setting` (AI on/off,
  auto-accept off by default + threshold), ClassificationOutcome accuracy). Review endpoint refuses
  while classification reasons are open. Client ClassificationPanel (quote chips find text on the
  page), ReviewQueuePage `/review`, AiSettingsCard on TaxonomyPage. See `docs/capture/classification.md`.
- [x] P11 Document splitting — `features/splitting` (pages: page source = original PDF or PDF view,
  per-page text from OcrPage / text layer, page JPEGs; separators: QR (jsQR) + printed code
  `DOCP-SEP:v1;type=;emp=`, blank-page mode, printable sheet (qrcode + pdf-lib); suggest: AI cuts
  with reasons; service: validatePlan, applySplit (atomic lock, parts as PDFs with derivedFrom/
  splitFrom, OCR/text reused, original gets splitInto and leaves search/handoff/dedupe), autoSplit
  in new blocking `separate` stage; lineage). Classification uses splitFrom.prefill; name/ID
  mismatch flagged. All pdf-parse calls go through `documents/formats/pdfText.js`. Client
  SplitPage `/files/:id/pages` (react-pdf thumbnails, cuts, rotate, remove, preview), PagesCard,
  SeparatorSheetCard. See `docs/capture/splitting.md`.
- [x] P12 Document merging — `features/merging` (preview: sources, person/type conflicts,
  strictest confidentiality, mixedRestricted; merge: ordered pages [{fileId,page,rotate}] copied
  from each source's page source, mergeOf.pageTexts + OcrPage words remapped, derivedFrom,
  optional supersede, audit document.merged). File.confidentialityFloor enforced in
  applyMetadata; already-restricted docs always go to the restricted queue. pdfText.js fixes
  pdf-parse's pooled-Buffer bug. Client MergeModal (drag/←→ reorder, rotate, leave out, conflicts,
  restricted acknowledgement) from the Documents bulk bar. See `docs/capture/merging.md`.
- [x] P13 Scanning — client `features/scan` (CameraScanPage `/scan`: live camera + outline,
  detectQuad / homography / warp / documentFilter in scanMath.ts, draggable corners, multi-page,
  reorder/retake, pdf-lib PDF → uploadFile with hints {source:'camera', device, pages}; photo-picker
  fallback; ScanTips; ScannerFoldersCard in Settings). Backend: upload accepts hints.source
  upload|camera (+ audit document.captured); `features/hotfolder` (profiles in Setting
  'hotfolders', local share under HOTFOLDER_ROOT or S3 prefix, stability check, import → File
  source=scanner + batch per sub-folder/day, move to .imported/.rejected, HotFolderImport log,
  scheduler started from backend/app.js), storage.listObjects. See `docs/capture/scanning.md`.
- [x] P14 Batch scanning — `features/batches/scan.js` (Batch.kind 'scan' + boxId, expectedPages,
  splitMode separators|suggest|auto, qc; createScanBatch, summarize → pages received / in
  documents / removed (File.splitRemoved) / missing, counts by tag, byType/byPerson; QC sample
  (Setting 'qc', default 10%) + results → File.rescan + RESCAN reason; reconciliation CSV/PDF).
  splitting/service aiSplitForBatch in the `separate` stage (SPLIT_SUGGESTED reason, classify
  waits) + keepWhole; hot folder sub-folder = box ID → scan batch. Client ScanBatchView (on
  BatchPage for scan batches), start form on BatchesPage, camera `?batch=`, SplitPage "Keep as
  one document". See `docs/capture/batch-scanning.md`.
- [x] P15 Email capture — `features/emailintake` (EmailSource: sources/local.js (.eml folder) +
  sources/graph.js (client credentials, list/fetch MIME/move to Inbox/Processed|Rejected);
  service: Message-ID dedupe, allow-list (Setting 'emailintake', empty = reject all), DMARC fail
  reject, store as source=email File (P05 makes body + attachment documents), containerOnly when
  the body says nothing, intakeHints → classifier <email_hints> (restricted words protective),
  daily batch, EmailIntakeLog, audit without body; scheduler from backend/app.js).
  documents/children.js skips exact-duplicate email attachments (AttachmentClaim unique, TTL 1h);
  documents/container.js isContainer/NOT_CONTAINER; hand-off serialized per document. Client
  EmailIntakeCard in Settings. See `docs/capture/email.md`.
- [x] P16 Import from shared drives — `features/migration` (sources local.js / sharepoint.js
  (Graph drives, Sites.Selected); mapping.js pattern rules {EmployeeID}/{Category}/**, directory
  check; service: createRun, inventory (hash, problems, in-source duplicates, by type/age), map
  (dry run), migrate (test subset / production, rate limit, MigrationLedger unique claim →
  idempotent, File.prefill → classification suggestion, metadata.migration keeps path/dates/
  owner), reconcile (accounted-for + hash verification), CSV reports; models MigrationRun/Item/
  Ledger). CLI `backend/scripts/migrate.js`; admin MigrationsPage `/migrations`. See
  `docs/capture/shared-drives.md`.
- [ ] P17 Paper conversion method (document)
