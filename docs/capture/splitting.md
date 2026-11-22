# Document splitting (RFP capture feature: "document splitting")

One multi-document file, such as a 40-page scan of a personnel folder, becomes separate,
correctly filed documents. The original is **never changed or deleted**. It stays linked to its
parts.

## Three ways to split

| Way | How | When |
|---|---|---|
| **Separator sheets** | Automatic, in the intake pipeline (`separate` stage, after text extraction) | Paper batches prepared with printed separator sheets |
| **AI-suggested cuts** | "Suggest cuts with AI" in the page view. Each cut comes with a reason, e.g. *Page 4 starts a new form: 'BENEFIT ELECTION FORM 2026'* | Bundles scanned without sheets |
| **Manual** | Click between two thumbnails to place or remove a cut | Anything else, or to correct a suggestion |

All three feed the same confirm step: **Preview split…**, then **Confirm split**.

## Page view (`/files/:id/pages`)

- Thumbnails of every page, with zoom, **rotate** (↻, 90° steps) and **remove** (🗑, e.g. blank
  pages). "Remove N blank pages" removes all blank pages at once.
- Blank pages (fewer than `OCR_BLANK_PAGE_WORDS` words) and separator sheets are labelled.
- Sidebar: the resulting documents. Each one gets an optional name, a document type and an
  employee ID. The type and ID pre-fill the details, which a person then confirms through the
  normal review (P10).
- Preview lists every resulting document with its pages before anything is created.
- Thumbnails are drawn in the browser by pdf.js from `GET /api/files/:id/pages.pdf`. The page
  source is the original PDF, or for scans and TIFFs the searchable PDF view. *Deviation from the
  prompt ("generated in the worker"):* the server has no PDF rasteriser, and pdf.js renders every
  page type the same way (digital, scanned, rotated) without storing extra images.

## Separator sheets

`GET /api/separator-sheet.pdf?documentType=&employeeId=&copies=` produces a printable sheet with
the same code in two forms:

- a **QR code**, read from the scan image of the page (jsQR), and
- a **printed text line** `DOCP-SEP:v1;type=<document type key>;emp=<employee ID>`, read from the
  OCR or text layer. This still works if the QR code is damaged or the page was not scanned as an
  image.

`type` and `emp` are optional. When present, they pre-fill the document that follows the sheet.
Separator pages are dropped from the parts. Staff print sheets from the page view ("Separator
sheets" card).

Admin settings (`GET/PUT /api/settings/splitting`):

| Setting | Default | |
|---|---|---|
| `separatorSheets` | on | Cut at separator sheets automatically |
| `blankIsSeparator` | off | Also treat blank pages as separators. Only use this if the scanning procedure never produces blank backs |

## What a split creates

- **Parts**: new PDF documents (`<name> - part N (<type>).pdf`) with `derivedFrom = [original]`,
  `parentDocumentId` and `splitFrom { fileId, splitId, part, pages: [original page numbers], via,
  prefill }`. Each part runs the pipeline on its own: duplicates, classification, index, view and
  hand-off.
- **No second OCR**: a part reuses the OCR of its pages (copied `OcrPage` records), or, for digital
  PDFs, the page text read from the original (`splitFrom.pageTexts`). Splitting never re-reads or
  re-bills a page. On rotated pages the word boxes are dropped (they would no longer line up), but
  the text is kept.
- **The original** gets `splitInto`, `splitAt` and `splitBy`. It stays viewable and linked
  ("Split into 3 documents", with links). Its open review reasons are closed with resolution
  `split`. It leaves search and is never handed to the partner: its parts are.
- **Audit**: `document.split` with `via`, `pageCount`, each part's pages, `removedPages` and
  `rotatedPages`. `split.suggested` records the AI's cuts.

## Rules

- Every page must be in exactly one part or explicitly removed. The API refuses plans that would
  lose a page silently, overlap parts, or leave a part with no pages.
- A document is split once (guarded by an atomic lock). Documents still processing, or already
  handed to the HR system, cannot be split here.
- **Restricted stays restricted**: parts of a restricted original start out restricted. A permitted
  reviewer can release a part to the general queue after checking it (P10).
- Split parts and their original are never reported as duplicates of each other.
- A name/ID conflict, where the document says "Maria Rivera (ID 3310)" but ID 3310 is someone else
  in the directory, is flagged to the reviewer. Such a suggestion is never auto-accepted.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/files/:id/pages?userId` | Pages (words, blank, snippet, separator), separator parts, saved AI suggestion, splittable |
| GET | `/api/files/:id/pages.pdf?userId` | The page source PDF (for thumbnails) |
| POST | `/api/files/:id/split/suggest` `{userId}` | AI cuts (needs AI switched on) |
| POST | `/api/files/:id/split` `{userId, parts:[{from,to,name?,documentType?,employeeId?}], removed:[], rotations:{page:deg}, via}` | Create the parts |
| GET | `/api/files/:id/lineage?userId` | Original ↔ parts links |
| GET | `/api/separator-sheet.pdf` | Printable separator sheet |
| GET / PUT | `/api/settings/splitting` | Admin settings |

## AI use

The AI sees the first 1,200 characters of each page (up to 200 pages) and the list of document
types. It never sees images. The same disclosure, off switch and human-review rules apply as for
classification (see `classification.md`). With AI off, separator sheets and manual cuts still
work.

## Notes

- pdf-parse read small PDFs unreliably (Node buffer-pool bug, fixed in P12 — see `merging.md`).
  Parts are saved with a classic xref table for the widest reader compatibility.
- QR codes are read from pages that carry a JPEG scan image (scanned PDFs and TIFF views). Printed
  sheets in digital PDFs are found by their text line.

## Tests

`backend/tests/integration/splitting.test.js` covers:

- AI split of a 10-page / 3-form fixture into 3 separately classified parts, with the original
  preserved
- QR and printed separator sheets splitting a file automatically, with pre-filled details
- blank-page mode
- manual split with a rotated and a removed page
- restricted access
- OCR reuse
- plan validation
- the separator sheet itself

Client: `splitPlan.test.ts` and `SplitPage.test.tsx`.

A live run against S3 and the real AI cut the 10-page bundle at pages 4 and 7, with reasons quoted
from the pages. Each part was classified on its own, and a printed + QR separator batch split into
3 parts with the sheets removed.
