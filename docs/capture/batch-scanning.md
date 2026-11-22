# Batch scanning (RFP capture feature: "batch scanning")

A large stack, such as a records box, is scanned in one run. The system separates, reads,
classifies and tracks it, then produces a **reconciliation report** proving that every page
arrived and ended up in a document.

## 1. Start a scan batch

**Batches → ＋ Start scan batch**:
- name
- **box / folder ID** (the label on the box)
- **expected pages** (optional)
- how documents are separated:

| Mode | What happens to each scanned file |
|---|---|
| **Separator sheets; otherwise the AI suggests cuts to check** (default) | Cut at separator sheets (P11). A multi-page file without sheets gets AI-suggested cuts. It waits in *Split to check* until a person splits it (page view, cuts pre-placed) or chooses **Keep as one document** |
| Separator sheets; otherwise the AI cuts automatically | As above, but the AI's cuts are applied. The parts still go through review |
| Separator sheets only | Unseparated files stay whole |

Pages reach the batch three ways:
- **Upload scans** on the batch page
- **📷 Scan with camera**, which keeps adding documents to the batch (`/scan?batch=<id>`)
- the **scanner folder**: save from the copier into a sub-folder named after the **box ID**
  (e.g. `\\fileserver\hr-scans\hr\BOX-12\`). The hot folder (P13) attaches those files to the
  open scan batch with that box ID.

## 2. Automatic flow per file

Each file runs:
1. store, hash
2. **OCR** (P06)
3. **separate**: separator sheets first, else the AI split per the batch mode
4. **duplicate check** (P08)
5. **classify** (P10). Each part is classified separately. The bundle itself is never classified,
   and a file with an open split suggestion waits.
6. review queues, index, hand-off

Separator-sheet details (type, employee ID) pre-fill each part.

## 3. Batch dashboard

`/batches/<id>` for a scan batch shows:

- **Page reconciliation**:
  - pages **received** (of expected, with a progress bar)
  - **in documents**
  - **removed** (separator sheets and blank pages dropped when splitting)
  - **missing** = received − in documents − removed

  Missing is shown once nothing is processing. It is 0 for a complete conversion.
- **Documents by state**: Ready · Needs review · Restricted · Possible duplicates · Split to
  check · Rescan · Failed · Processing. Click a tile to **drill down**.
- **Bulk actions**: select documents → **Edit details** (P09 bulk edit); **Retry failed**.
- **Finish batch**: no more pages are coming. The batch completes when every file is final
  (audit `batch.completed`).
- Large batches (1,000+ pages) process through the same queue. The page polls a summary and
  never blocks, so staff keep working while it runs.

## 4. Quality control

**Pick sample** draws a random sample of the finished documents (`crypto.randomInt`). The default
is **10%**, set by an administrator (`PUT /api/settings/qc`), and can be overridden per sample.
At least one document is always checked.

- The reviewer compares each sampled document with the paper and records **Pass** or **Fail**.
  A fail needs a reason, e.g. "page 2 is cut off".
- A **fail** marks the document for **rescan**: `File.rescan = { note, by, at }`, a review reason
  "Failed the quality check: … — rescan the paper original", and it appears under **Rescan**.
  Changing it to **pass** later clears the flag.
- Drawing a new sample after results exist must be confirmed (`replace: true`).
- Audit: `batch.qc_sampled` `{ percent, eligible, sampled }` and `batch.qc_result`
  `{ result, note }`.

## 5. Reconciliation report (CSV + PDF)

`GET /api/batches/:id/reconciliation.csv` | `.pdf` (buttons on the dashboard). Contents:

- batch, box ID, who started it and when, completion time, who generated the report and when;
  a note when figures are provisional (still processing)
- **pages**: expected, received, in documents, removed, **missing**
- **documents**: files received, documents created, ready / needs review / restricted / possible
  duplicates / failed / marked for rescan
- documents **per type** and **per person**
- **quality check**: sample size and %, passed / failed / not checked, each sampled document
- **exceptions**: missing pages, page-count mismatch against expected, failed files, rescans,
  possible duplicates, undecided splits, other review reasons
- every **document created**, with its pages and the original stack pages it came from

The CSV opens in Excel (UTF-8 BOM, CRLF, formula-injection safe). Audit: `batch.report_generated`
`{ format, missingPages }`. This report is the evidence step of the paper-conversion method (P17).

## API

| Method | Path | |
|---|---|---|
| POST | `/api/batches/scan` `{ userId, name?, boxId?, expectedPages?, splitMode? }` | Start (audit `batch.started`) |
| GET | `/api/batches/:id/scan?userId` | Dashboard summary |
| POST | `/api/batches/:id/qc/sample` `{ userId, percent?, replace? }` | Draw the QC sample |
| POST | `/api/batches/:id/qc/:fileId` `{ userId, result: pass\|fail, note }` | Record a result |
| GET | `/api/batches/:id/reconciliation.csv` / `.pdf` | Report |
| GET / PUT | `/api/settings/qc` | Default sample % (admin) |
| POST | `/api/files/:id/split/keep` | Keep a suggested-split file as one document (then it is classified) |
| POST | `/api/batches/:id/close` | Finish (existing) |

## How the page figures are computed

For the files in a batch:
- **received** = page counts of files that arrived (not parts)
- **in documents** = page counts of files that are not split originals (the parts, plus whole
  files)
- **removed** = `splitRemoved` pages recorded on each split original

Nested splits are counted correctly: a part split again counts as neither received nor a
document, and its removed pages are added.

## Tests

`backend/tests/integration/scanbatch.test.js` covers:

- **the acceptance case**: a 30-page fixture stack with 5 separator sheets becomes 6 documents,
  each classified separately (the separator details win). Reconciliation: received 30, in
  documents 25, removed 5, **missing 0**, in both CSV and PDF. Finish → completed.
- AI-suggested cuts waiting for a decision; mark-reviewed blocked; keep-as-one, then classified
- auto mode applies AI cuts; separators-only mode leaves stacks whole
- scanner sub-folder named after the box ID feeds the batch
- validation and ownership
- **QC**: default 10% of 6 = 1, admin 50% = 3 distinct documents; pass / fail with required
  reason; rescan flag and reason; replace guard; report section; audit counts; pass clears

Client: `ScanBatchView.test.tsx` (reconciliation figures, drill-down, QC flow, start form).

Live run against S3 and the real AI: the 30-page stack became 6 documents in 87 s, each classified
to the right type and person. Pages reconciled 30 = 25 + 5 with 0 missing. A 34% sample picked 3
of 6, pass and fail were recorded, the CSV and PDF reports were generated, and Finish completed
the batch.
