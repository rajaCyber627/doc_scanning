# Capture Hub — Implementation Prompts

Prompts for building the **Document Capture and Scanning** scope of RFP #340-27-YE
(City of Portsmouth HRDMS) on top of DocP. Our module is the *front door*: it captures,
reads, cleans up and labels documents, then hands them to the partner vendor's HRDMS
(the system of record).

## How to use

- Run **one prompt per Claude Code session**, in order. Start each in a fresh session.
- Each prompt reads `docs/capture/CONTEXT.md` first (created by P00), so shared rules
  are written once.
- Bigger prompts ask Claude to **plan first and wait for your approval** before editing.
- After each prompt: review the diff, run the app, then commit yourself.
- **P17 (paper conversion method) has no code and no dependencies. Run it now** — it is
  needed for the proposal due **Thu Dec 3, 2026, 2:00 p.m. EST**.

## Order

| # | Prompt | RFP item | Depends on |
|---|--------|----------|------------|
| P00 | Shared context file | — (setup) | — |
| P01 | Pipeline foundation & test harness | — (prerequisite) | P00 |
| P02 | Individual upload (direct-to-S3) | individual document upload | P01 |
| P03 | Bulk upload & batches | bulk document upload | P02 |
| P04 | Drag-and-drop | drag-and-drop functionality | P03 |
| P05 | Electronic document import | electronic document import | P01 |
| P06 | OCR | optical character recognition | P05 |
| P07 | Full-text indexing | full-text indexing | P06 |
| P08 | Duplicate detection | duplicate detection where available | P01 |
| P09 | Metadata entry | metadata entry | P01 |
| P10 | Automated / assisted classification | automated or assisted classification | P06, P09 |
| P11 | Document splitting | document splitting | P06, P10 |
| P12 | Document merging | document merging | P11 |
| P13 | Scanning | scanning | P03, P06 |
| P14 | Batch scanning | batch scanning | P11, P13 |
| P15 | Email capture | email capture | P05, P08 |
| P16 | Import from shared drives | import from shared drives | P05, P08, P09 |
| P17 | Paper conversion method (document) | convert paper personnel records | — (**run now**) |

---

## P00 — Shared context file

```
Create docs/capture/CONTEXT.md: the single reference every later prompt will read
before working. Do NOT change any code in this task.

First read: README.md, backend/app.js, backend/File.js, backend/Folder.js,
backend/userModel.js, client/src/api.ts, client/src/pages/Documents.tsx,
client/src/pages/FolderPage.tsx, and docs/capture/PROMPTS.md.

CONTEXT.md must contain these sections:

1. Scope — we build only the RFP "Document Capture and Scanning" items: individual
   upload, bulk upload, drag-and-drop, scanning, batch scanning, OCR, full-text
   indexing, email capture, electronic document import, import from shared drives,
   automated/assisted classification, metadata entry, document splitting, document
   merging, duplicate detection, plus a written paper-conversion method.
2. Out of scope (owned by the partner HRDMS) — security matrix, personnel-file view,
   search UI, workflow, retention/holds, audit storage, version store, reporting.
   We only integrate with these.
3. Architecture — intake channels → pipeline (store → hash/duplicate check →
   extract/OCR → split suggestion → classify → review) → hand-off to partner.
   Include an ASCII diagram.
4. Partner hand-off — partner API is NOT known yet. All hand-off goes through a
   PartnerAdapter interface (pushDocument, pushAuditEvent, findByHash,
   lookupPerson) with a MockPartnerAdapter used locally. No feature may call the
   partner directly.
5. Domain rules from the RFP:
   - Records exist for employees, applicants and retirees.
   - The 10 HR record categories and their document types (RFP pp. 5-8): Personnel,
     Benefits, Medical & Confidential, FMLA & Leave, ADA & Accommodation, Workers'
     Compensation, Employee Relations, Recruitment, Classification & Compensation,
     Training & Development. List every document type under each.
   - Metadata fields (RFP pp. 9-10): employee name, employee ID, position title,
     department, division, document type, HR functional area, effective date,
     creation date, fiscal year, record category, retention category,
     confidentiality level, status, case number, applicant number, position number,
     plus configurable fields.
   - Restricted categories: medical, FMLA, ADA, workers' comp, employee-relations
     investigations, grievances. These must never be visible to general reviewers.
   - Splitting/merging must preserve originals. Every capture action must emit an
     audit event (user, action, document, timestamp).
   - AI features must be optional (admin off switch) with human review.
6. Current state — what DocP already does, with file:line references (upload route,
   extractContent, runTextract, processFile, File model fields, accepted file types,
   the 25 MB multer limit, the ~4.5 MB Vercel proxy limit).
7. Known environment limits — AWS Textract is NOT activated on the dev account
   (SubscriptionRequiredException); local MongoDB has no Atlas Vector Search. Features
   must degrade gracefully and be testable with mocks/fixtures.
8. Known bugs — login matches the first user when userNameorEmail is missing
   (backend/app.js login route); upload failures show only "Failed" with no reason.
9. Working rules for every task:
   - Read CONTEXT.md and the relevant code before changing anything.
   - For non-trivial tasks: present a short plan (files, data changes, risks) and wait
     for approval before editing.
   - Keep existing features working; no unrelated refactors.
   - New backend logic goes in modules under backend/src/ (once P01 creates it), not
     in app.js.
   - Add or update tests for new logic; run them and report results honestly.
   - Never commit. Never print secrets from backend/.env.
   - Finish with: summary of changes, how to test manually, open questions, and an
     update to the "Progress" section of CONTEXT.md.
10. Progress — a checklist of P01-P17, all unchecked.

Keep it factual and concise (aim for under 300 lines). Show me the file when done.
```

---

## P01 — Pipeline foundation & test harness

```
Read docs/capture/CONTEXT.md first and follow its working rules.

Goal: prepare the backend so the capture features can be added cleanly. This is a
prerequisite, not a feature — no user-visible behavior should change.

Plan first and wait for my approval.

Requirements:
1. Modularize: move logic out of backend/app.js into backend/src/ modules
   (e.g. routes/, services/, pipeline/, models/). app.js keeps only app setup and
   route mounting. All existing /api routes must keep the same paths and responses.
2. Intake pipeline: replace the fire-and-forget processFile() with an explicit
   pipeline of named stages (store, hash, extract, classify, index, handoff) and a
   per-document stage/status record (status, current stage, error message, attempt
   count, timestamps). Stages that don't exist yet are no-ops.
3. Job queue: run pipeline stages through a queue abstraction with a local
   in-process implementation (an SQS implementation can come later). Failed stages
   retry with backoff; final failures store a human-readable error on the document.
4. Data model additions on File (or a new Document model if cleaner — justify):
   sha256, sizeBytes, pageCount, source (upload | camera | scanner | email | import),
   batchId, metadata (object), classification (object), parentDocumentId,
   derivedFrom (for split/merge), confidentiality, pipeline status fields.
   New Batch model: name, source, createdBy, counts by status, timestamps.
5. Audit events: an emitAudit(user, action, documentId, details) helper that writes
   to a local AuditEvent collection and calls PartnerAdapter.pushAuditEvent.
6. PartnerAdapter interface + MockPartnerAdapter (see CONTEXT.md §4).
7. Test harness: Jest + supertest with an in-memory MongoDB, and mocks for S3,
   Textract and Anthropic. Add `npm test` in backend/. Cover: upload → pipeline →
   ready, and a failing stage → retry → failed with error message.
8. Fix the login bug: reject login when userNameorEmail is missing or empty.

Out of scope: new UI, new file types, OCR changes, SSO.

Acceptance:
- All existing routes behave as before (verify with the tests and a manual upload of
  a .txt and a .docx through http://localhost:3000).
- `npm test` passes.
- A failed upload now stores a readable error instead of a generic failure.
```

---

## P02 — Individual document upload (direct-to-S3)

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "individual document upload".

Goal: uploading one document works for files of any reasonable size and gives clear
feedback at every step.

Current state: files go browser → Vercel proxy (~4.5 MB limit) → multer in memory
(25 MB) → S3. See the upload route and client/src/api.ts.

Plan first and wait for my approval.

Requirements:
1. Direct-to-S3 upload: client asks the backend for a presigned PUT URL (validate
   type and size server-side first), uploads straight to S3, then calls a
   "complete" endpoint that creates the document and starts the pipeline.
   Use multipart upload for files over 10 MB. Max size configurable (default 100 MB).
2. Server-side checks on "complete": object exists, size matches, file type sniffed
   from content (not just extension), and the user owns the upload.
3. UI: per-file progress bar, then pipeline stage ("Uploading → Reading text →
   Classifying → Ready"), and on failure the real error message with a Retry
   button (retry re-runs the failed stage, not the upload).
4. Optional at upload time: choose an existing employee/folder and document type
   (fields can be empty until P09 exists — leave a clear hook).
5. Emit audit events: upload.started, upload.completed, upload.failed.
6. Keep the old multipart route working behind a flag for local dev without S3 CORS,
   and document how to configure the S3 bucket CORS for the browser upload.

Out of scope: multiple files (P03), drag-and-drop changes (P04), new formats (P05).

Acceptance:
- A 30 MB PDF uploads successfully through http://localhost:3000.
- An unsupported type is rejected with a clear message before upload starts.
- Tests cover presign validation, complete-step checks, and ownership.
```

---

## P03 — Bulk document upload & batches

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "bulk document upload".

Goal: HR staff can upload hundreds of files in one action and track them as a batch.

Plan first and wait for my approval.

Requirements:
1. Select many files (and whole folders via the browser's directory picker); upload
   them through the P02 direct-to-S3 flow with limited concurrency (default 4) and
   automatic retry of failed parts.
2. Every bulk upload creates a Batch (P01 model). User can name it; default name
   includes date/time and uploader.
3. Batch page: totals (uploaded / processing / ready / needs review / failed),
   per-file status and error, "Retry failed", "Remove", and a downloadable CSV
   report of the batch.
4. Server handles a 500-file batch without blocking other users (all processing via
   the queue, not in the request).
5. Uploading must survive a page refresh: unfinished files are listed so the user
   can resume or cancel.
6. Keep existing "sets/folders" working; decide (and explain) whether a batch and a
   folder are the same thing or separate — a batch is an intake concept, a folder is
   an organization concept.
7. Audit events: batch.created, batch.completed, plus per-file upload events.

Out of scope: auto-splitting (P11/P14), classification (P10).

Acceptance:
- 200 small files upload in one action and appear on the batch page with correct
  counts.
- Killing one file's upload mid-way leaves it as "failed" with a retry option while
  the rest succeed.
- Tests cover batch counts and the CSV report.
```

---

## P04 — Drag-and-drop

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "drag-and-drop functionality".

Goal: drag-and-drop works consistently everywhere a user can add documents.

Current state: react-dropzone on the Documents page (client/src/pages/Documents.tsx)
and a file input on FolderPage.tsx; accepted types are duplicated in several places.

Requirements:
1. One shared drop-zone component used on: Documents page, folder/set page, batch
   page, and (once P09 exists) an employee/record view.
2. Supports single files, many files, and dropped folders (keeping the relative path
   so P16-style folder rules can use it later).
3. Clear states: idle, drag-over highlight, rejected (with reason: type, size),
   uploading. Full-page drop overlay when dragging over the window.
4. Keyboard and screen-reader accessible (a visible "Browse files" button, ARIA
   labels, focus states) — the City lists accessibility as an outcome.
5. One shared list of accepted types and max size, read from the backend config so
   client and server never disagree.
6. Dropping onto a folder/employee pre-fills that target for the uploaded files.

Out of scope: new file types (P05).

Acceptance:
- Drag a folder with 20 files onto the batch page → one batch, paths preserved.
- A .exe dropped shows a rejection message and is not uploaded.
- Works with keyboard only.
```

---

## P05 — Electronic document import

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "electronic document import".

Goal: accept the file types HR actually receives, and give every document a
consistent viewable PDF rendition.

Current state: .pdf, .png, .jpg, .jpeg, .tif, .tiff, .docx, .txt, .md, .csv
(see extractContent in the backend and the accept lists in the client).

Plan first and wait for my approval.

Requirements:
1. Add: .doc, .rtf, .xlsx/.xls, .pptx, .odt, .msg, .eml, .heic/.heif, multi-page .tif,
   .gif/.bmp, and .zip (expand and import each entry, rejecting nested executables).
2. Text extraction per type (pick well-maintained libraries; justify each choice).
3. PDF rendition for viewing: convert Office/text/image formats to PDF (e.g. headless
   LibreOffice in the worker; images → PDF). Keep the original file untouched; the
   rendition is a separate S3 object linked to the document.
4. .msg/.eml: the email body becomes a document; each attachment becomes its own
   document linked to the parent email (reuse this in P15).
5. Safety: file-type sniffing, size limits, zip-bomb protection (max entries,
   max total size, max depth), password-protected files fail with a clear message.
6. Unsupported files fail early with the reason shown to the user.
7. Tests with a small fixture of each type.

Out of scope: OCR changes (P06).

Acceptance:
- Each new type uploads, shows text, and opens as a PDF rendition in the viewer.
- A .msg with 2 attachments produces 3 linked documents.
- Document the system dependencies (e.g. LibreOffice) for local dev and EC2.
```

---

## P06 — Optical character recognition (OCR)

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "optical character recognition".

Goal: scanned PDFs and images become accurate, searchable text, with problems
flagged for a human.

Current state: runTextract/runTextractMode in the backend. Known gaps: tables are
discarded (blocksToTablesCsv is unused), word geometry is capped at 8,000 words,
Textract confidence is ignored, and the dev AWS account has Textract inactive.

Plan first and wait for my approval.

Requirements:
1. OCR provider interface with: TextractProvider (DetectDocumentText, plus
   AnalyzeDocument FORMS+TABLES for forms) and a FixtureProvider that returns saved
   Textract JSON so everything is testable while Textract is inactive. Select by env.
2. Per page: text, word boxes, average confidence, detected key-value pairs (form
   fields), tables. Store per page, not one blob, and remove the 8,000-word cap
   (store geometry efficiently, e.g. per page in S3 or a separate collection).
3. Searchable PDF output: original page images with an invisible text layer
   (PDF/A where possible), stored as the document's rendition.
4. Quality flags: low-confidence pages (threshold configurable), blank pages,
   probable handwriting, rotated/skewed pages. Flagged documents go to "needs review"
   with the reason.
5. Pre-processing for camera/scanner images: auto-rotate and deskew before OCR.
6. Keep the existing "digital PDF → read text layer free" shortcut.
7. Clear error when Textract is not activated ("OCR service not activated on the
   AWS account") instead of a generic failure.
8. Keep on-image find highlighting working with the new storage.

Out of scope: classification (P10).

Acceptance:
- With FixtureProvider: a 3-page scanned PDF yields per-page text, confidence,
  form fields, a searchable PDF, and highlight boxes in the viewer.
- A low-confidence fixture lands in "needs review" with the reason.
- Tests cover provider selection, flags, and the digital-PDF shortcut.
```

---

## P07 — Full-text indexing

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "full-text indexing".

Goal: every captured document's full text is indexed and available to the partner's
search; our hub can also search its own intake documents.

Note: the partner owns the main search. Our job is to produce index-ready content and
hand it off, plus a local search for documents still in intake/review.

Plan first and wait for my approval.

Requirements:
1. An "index" pipeline stage that produces: normalized full text per page, the
   searchable PDF (from P06), and an index record (document id, metadata, text,
   page offsets, language).
2. Send it via PartnerAdapter.pushDocument (mock logs it). Make the payload format a
   documented JSON schema in docs/capture/.
3. Local intake search: replace the current regex scan (/api/search) with a proper
   MongoDB text index (works locally) behind a SearchProvider interface, with an
   Atlas Search implementation stub for later. Support phrase search, filters
   (batch, status, document type, date range) and highlighted snippets.
4. Search results must respect the restricted-category rule in CONTEXT.md: a user
   without access must not see restricted documents or learn they exist (no counts,
   no snippets).
5. Re-index on metadata change, split, merge, and OCR re-run.
6. Backfill script for existing documents.

Out of scope: semantic "Ask everything" changes.

Acceptance:
- Searching a word that appears only inside a scanned fixture finds it with a
  highlighted snippet.
- A restricted document never appears for a user without access (test this).
- Payload schema file exists and the mock adapter receives valid payloads.
```

---

## P08 — Duplicate detection

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "duplicate detection where available".

Goal: warn before the same document is stored twice, and let the user decide.

Plan first and wait for my approval.

Requirements:
1. Exact duplicates: SHA-256 of the original file (computed in the P01 hash stage).
   Check against (a) the same batch, (b) all hub documents, (c) the partner via
   PartnerAdapter.findByHash.
2. Same-content duplicates: a fingerprint of normalized extracted text (so the same
   paper scanned twice, or a .docx and its PDF export, match). Configurable
   similarity threshold.
3. On match: document goes to "possible duplicate" with a side-by-side compare view
   showing what matched and where the existing copy lives (hub or partner, upload
   date, uploader — but respect restricted access: say "a restricted record already
   exists" without details if the user lacks access).
4. Actions: Keep both, Replace existing (creates a new version, never deletes), or
   Discard new. Bulk actions on the batch page.
5. Every decision is an audit event with the reason.
6. Batch summary shows duplicate counts; shared-drive import (P16) will reuse this.

Out of scope: semantic near-duplicates via embeddings (optional later).

Acceptance:
- Uploading the same file twice flags the second as an exact duplicate.
- A .docx and its PDF export are flagged as same-content duplicates.
- Tests cover all three actions and the restricted-access message.
```

---

## P09 — Metadata entry

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "metadata entry".

Goal: HR can label every document with the City's standard metadata, quickly and
consistently.

Plan first and wait for my approval.

Requirements:
1. Configurable taxonomy, managed by an admin (seeded from CONTEXT.md §5):
   record categories → document types; each document type defines its required and
   optional fields, default confidentiality, and default retention category.
   Stored in the database, with import/export as JSON so it can be synced with the
   partner's master list.
2. Field types: text, number, date, fiscal year (derived from date, City fiscal year
   start configurable), pick-list, person (employee/applicant/retiree lookup).
3. Person lookup via PartnerAdapter.lookupPerson (mock returns sample people from a
   seed file): search by name or ID, shows department/position/status, and fills
   name, ID, position, department and division automatically.
4. Metadata panel beside the document viewer: validation of required fields,
   "save" and "save & next" for fast keying, keyboard shortcuts.
5. Bulk edit: select many documents, set shared fields at once (e.g. employee and
   fiscal year), with a preview of what will change.
6. Every change is an audit event (field, old value, new value, user).
7. A document can't be handed off to the partner until required fields are valid.

Out of scope: AI suggestions (P10).

Acceptance:
- Admin adds a new document type with a custom field; it appears in the panel.
- Picking an employee fills the five person fields.
- Bulk-editing 20 documents updates all of them and logs 20 audit events.
```

---

## P10 — Automated / assisted classification

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "automated or assisted classification".

Goal: the system suggests document type, person and metadata; a human confirms.
Restricted documents are protected from the moment they arrive.

Plan first and wait for my approval.

Requirements:
1. A "classify" pipeline stage after OCR. Using the P09 taxonomy, the LLM returns
   strict JSON: record category, document type, confidentiality level, person
   (name/ID/applicant number as found in the text), metadata field values with the
   page/quote each came from, and a confidence (0-1) per field.
   Validate the JSON against a schema; invalid output → retry once → "needs review".
2. Match the person against PartnerAdapter.lookupPerson; record match quality.
3. Restricted-first routing: if confidentiality or category is restricted
   (CONTEXT.md §5), route to a restricted review queue visible only to users with
   that permission — even when confidence is low ("possibly medical" is enough).
4. Review queue UI: document viewer + suggested values with confidence badges and
   the source quote highlighted on the page; Accept all / edit / reassign; next item.
5. Admin settings: AI on/off switch (off = manual metadata entry only, everything
   still works), auto-accept threshold (default OFF — human reviews everything),
   per-document-type thresholds.
6. Accuracy tracking: store suggestion vs final value per field; a simple admin view
   of acceptance rate by document type.
7. Audit: what the AI suggested, what the reviewer decided, who and when.
8. Keep model IDs in one config; never send more text than needed (truncate by
   page); log no document text in server logs.
9. Tests with mocked LLM responses: valid, invalid JSON, restricted routing, AI off.

Out of scope: splitting suggestions (P11).

Acceptance:
- A W-4 fixture is suggested as Personnel/Benefits W-4 for the right employee with
  quoted evidence.
- A medical-certificate fixture goes only to the restricted queue.
- With AI switched off, documents go straight to manual metadata entry.
```

---

## P11 — Document splitting

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "document splitting".

Goal: one multi-document file (e.g. a 40-page scan of a personnel folder) becomes
correctly separated documents.

Plan first and wait for my approval.

Requirements:
1. Page view: thumbnails of every page (generated in the worker), zoom, rotate page,
   delete blank page.
2. Manual split: click between thumbnails to place cuts; name/type each resulting
   part; preview before confirming.
3. AI-suggested split: using per-page OCR text (P06) and the taxonomy, propose
   boundaries with a reason per cut ("page 4 starts a new form: W-4"). User accepts,
   moves or removes cuts.
4. Separator sheets: detect a barcode/QR separator page (and an optional "blank page
   = separator" mode); cut there and drop the separator pages. Provide a printable
   separator-sheet PDF (optionally encoding document type or employee ID to pre-fill
   metadata).
5. Result: new child documents (derivedFrom = original, page ranges recorded). The
   original is preserved and linked, never deleted. Each child runs classify → index.
6. Audit event for every split with page ranges.

Out of scope: merging (P12), the batch-scanning flow (P14).

Acceptance:
- A 10-page fixture containing 3 forms is split into 3 documents via AI suggestion,
  each classified separately, original still accessible.
- A fixture with QR separator pages splits automatically.
```

---

## P12 — Document merging

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "document merging".

Goal: combine separate files or pages into one document (e.g. 3 pages of a contract
scanned separately).

Requirements:
1. Select 2+ documents (or specific pages from them) → merge dialog with drag-to-
   reorder thumbnails, rotate, remove page.
2. Output is a new PDF document (use the PDF renditions from P05/P06 so mixed source
   types work) with combined OCR text and word geometry remapped to new page numbers.
3. Sources are preserved and linked (derivedFrom lists them); optionally mark
   sources as "superseded" — never delete.
4. Metadata: pre-fill from sources; if sources disagree (different employee or
   restricted vs non-restricted), warn and require the user to resolve. Never let a
   merge reduce confidentiality — the result takes the strictest level.
5. The merged document runs classify → index.
6. Audit event with source ids and page order.

Acceptance:
- Merge 3 single-page scans into one 3-page document; find-in-document works across
  all pages.
- Merging a medical page with a general page forces restricted confidentiality.
```

---

## P13 — Scanning

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "scanning".

Goal: HR can scan paper straight into the system, from a phone/tablet or from the
City's existing office scanners and copiers — without installing software on each PC.

Plan first and wait for my approval.

Requirements:
1. Camera capture (mobile-friendly web page): live camera, automatic page edge
   detection and crop, perspective correction, contrast/"document" filter, capture
   multiple pages, reorder/retake, then save as one PDF through the P02 upload flow
   with source = camera. Fallback to the device file picker when camera access is
   denied.
2. Scanner capture without desktop software:
   a) Watched folder ("hot folder"): a small service that monitors a configured
      network folder or S3 prefix where scanners save files; each new file is
      imported with source = scanner, the folder name can map to a batch/user.
   b) Scan-to-email: document the setup using the P15 intake mailbox.
3. Scan settings guidance in the UI: recommended 300 dpi, PDF, duplex, black-and-white
   for text / color only when needed.
4. Every scanned document goes through OCR (P06) and the normal pipeline.
5. Audit events with source and device/folder name.
6. Document (don't build) the option of direct browser scanner control via a
   commercial TWAIN/WIA SDK, for the proposal.

Out of scope: separating stacks into documents (P14).

Acceptance:
- On a phone, capture 3 pages → one PDF document with OCR text.
- Dropping a PDF into the watched folder imports it within a minute.
```

---

## P14 — Batch scanning

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "batch scanning".

Goal: scan a large stack in one run; the system separates, reads, classifies and
tracks it, and gives a reconciliation report.

Plan first and wait for my approval.

Requirements:
1. Start a scan batch in the UI (name, expected box/folder id, expected page count
   optional) → files arriving from camera, watched folder or upload attach to it.
2. Automatic flow per batch: OCR → split (separator sheets first, else AI
   suggestions from P11) → duplicate check (P08) → classify (P10) → review queues.
3. Batch dashboard: pages received, documents created, ready / needs review /
   restricted / duplicates / failed, with drill-down and bulk actions.
4. Quality control: pick a random sample (configurable %, default 10%) for a QC
   check; reviewer passes/fails each; failed items are marked for rescan.
5. Reconciliation report (CSV + PDF): pages in vs pages in documents, documents per
   type/person, exceptions, QC result, who/when. This report is also used in the
   paper-conversion method (P17).
6. Large batches (1,000+ pages) process via the queue without blocking the UI.
7. Audit events for batch start, completion, QC results, report generation.

Acceptance:
- A 30-page fixture stack with separator sheets becomes the right documents, each
  classified, with a reconciliation report showing 0 missing pages.
- QC sampling selects the configured percentage and records results.
```

---

## P15 — Email capture

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "email capture". The City uses Microsoft 365 / Outlook (RFP pp. 14-15).

Goal: documents sent by email reach the system without manual downloading.

Plan first and wait for my approval.

Requirements:
1. Shared mailbox intake via Microsoft Graph (application permissions limited to
   that one mailbox): poll or subscribe for new messages, import them, then move
   the message to a "Processed" (or "Rejected") folder.
2. Reuse P05 email handling: body → document, each attachment → document, linked.
   Options: ignore signature images/inline logos; import body only when it has
   meaningful content.
3. Sender allow-list (domains/addresses); others go to "Rejected" with a log entry.
4. Use subject/body hints to pre-fill metadata (e.g. "ID 1045", "FMLA") — feed them
   to classification (P10), never trust them blindly.
5. Duplicate check (P08) so forwarded copies aren't stored twice.
6. Local development: an EmailSource interface with (a) Graph implementation and
   (b) a local folder of .eml files for testing — no Microsoft tenant needed to test.
7. Manual import: users can drag saved .msg/.eml files in (P04/P05).
8. Document the Azure app registration and least-privilege mailbox scoping for the
   City's IT team, and note an Outlook add-in ("Send to HR file") as a future option.
9. Audit events with sender, subject hash and message id (not the body).

Acceptance:
- Dropping 3 .eml fixtures into the local email folder produces linked documents,
  rejects one from a non-allowed sender, and skips one duplicate.
```

---

## P16 — Import from shared drives

```
Read docs/capture/CONTEXT.md first and follow its working rules.

RFP item: "import from shared drives". Related RFP section: Data Migration (pp. 15-16):
discovery, inventory, mapping, metadata mapping, cleansing recommendations, duplicate
identification, test migration, validation, production migration, reconciliation,
exception reporting.

Goal: a safe, repeatable tool to move existing HR network folders and SharePoint
libraries into the system, with the reports the RFP requires.

Plan first and wait for my approval.

Requirements:
1. Sources behind one interface: local/network folder (SMB path mounted on the
   machine running the tool) and SharePoint/OneDrive via Microsoft Graph.
2. Step 1 — Discovery/inventory (read-only): walk the source, record path, size,
   type, dates, owner, hash; output an inventory report (CSV + summary: counts by
   type, size, age, unsupported files, likely duplicates, empty/corrupt files).
3. Step 2 — Mapping rules (a config file): folder patterns → person and metadata,
   e.g. "\Employees\{LastName}_{FirstName}_{EmployeeID}\{Category}\" → employee id,
   record category. Dry-run shows how every file would be mapped and lists
   unmapped files.
4. Step 3 — Test migration on a chosen subset, then production migration. Uses the
   normal pipeline (P05 formats, P06 OCR, P08 duplicates, P10 classification).
   Resumable, rate-limited, idempotent (re-running never creates duplicates).
5. Step 4 — Reconciliation and exceptions: source count vs imported vs skipped vs
   failed, with reasons; post-migration verification by hash.
6. Preserve original path, file dates and owner as metadata; never modify or delete
   the source.
7. Runs as a CLI (for large migrations) plus an admin page to view runs and reports.
8. Audit events per imported file with source path.

Acceptance:
- Running against a fixture folder tree (~50 files with a naming pattern, some
  duplicates and an unsupported file) produces inventory, dry-run mapping,
  migration, and a reconciliation report where every file is accounted for.
- Re-running the migration imports nothing new.
```

---

## P17 — Paper conversion method (document, no code)

```
Read docs/capture/CONTEXT.md if it exists, and docs/capture/PROMPTS.md.
No code changes in this task.

RFP item: "The vendor shall describe recommended methods for converting existing
paper personnel records into electronic records." (RFP #340-27-YE, City of
Portsmouth, VA — HR Document Management System.)

Audience: the City's HR Director, HR records staff, and the proposal evaluation
committee (non-technical). The evaluation weights "Proposed Technical Approach" at 30
points, so be specific and practical, not generic.

Write docs/capture/paper-conversion-method.md covering:
1. Summary — our recommended approach in one paragraph.
2. Approach options with pros/cons and our recommendation: backfile conversion vs
   day-forward scanning; in-house scanning with our software vs our scanning team vs
   a scanning bureau; scan-everything vs scan-on-demand for inactive files.
3. Discovery & inventory — counting boxes/files/pages, condition assessment,
   prioritization (active employees → retirees → applicants; by retention status),
   and identifying records already eligible for destruction (don't scan what can
   lawfully be destroyed — with City approval).
4. Preparation — removing staples/clips, repairing pages, handling odd sizes and
   photos, inserting barcode separator sheets (document type / employee ID),
   chain-of-custody log, secure storage and transport.
5. Scanning standards — 300 dpi minimum, PDF/A, duplex, blank-page removal,
   color/grayscale rules, file naming, image quality checks.
6. Processing in the Capture Hub — OCR, automatic splitting, AI-assisted
   classification with human review, restricted handling of medical/FMLA/ADA/
   workers' comp/employee-relations files, duplicate detection, metadata.
7. Quality control — sampling rate per batch, what reviewers check, rescan process,
   acceptance thresholds.
8. Reconciliation & certification — per-box reconciliation report, City sign-off.
9. Disposition of paper — follow Library of Virginia records-retention schedules and
   its process for certifying records destruction (verify current requirements and
   cite them); never destroy records under legal, audit, investigation, grievance,
   FOIA or administrative hold; option to retain originals for permanent records.
10. Security & confidentiality during conversion — background-checked staff, secure
    area, restricted-record handling, audit trail.
11. Day-forward process — how new paper is handled after go-live.
12. Timeline & staffing model — a formula based on page volume (pages/day per
    scanner station, prep and QC effort) with an example, since the City's volume is
    not yet known.
13. Roles & responsibilities — City vs vendor.
14. Risks & mitigations.
15. Assumptions and questions for the City.

Style: plain language, short paragraphs, tables where helpful, no marketing fluff.
Mark anything that needs confirmation (volumes, LVA requirements) clearly.
Also produce a one-page summary version at the top suitable for the proposal.
```
