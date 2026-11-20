# Document merging (RFP capture feature: "document merging")

Merging combines separate files or pages into one document, for example three pages of a contract
that were scanned one at a time. The sources are **never changed or deleted**.

## How staff use it

1. On **Documents**, select two or more documents, then click **⧉ Merge**.
2. The merge dialog shows every page of every selected document as thumbnails.
   - **Drag** a page to a new position, or use ← → (keyboard friendly).
   - **↻** rotates a page 90°. **✕** leaves a page out. "Left out" pages can be put back.
3. If the sources **disagree** on the person or the document type, the dialog shows the choices,
   with the documents that carry each one. The user picks one, or "Decide when reviewing the
   merged document".
4. If the selection mixes **restricted** pages (medical, leave, ADA, investigations…) with others,
   the user must confirm that the merged document will be **Restricted**.
5. Optional: **Mark the originals as replaced**. The originals stay in the system but are hidden
   from lists and search.
6. **Merge** → the new document opens.

## What a merge creates

- **A new PDF** (`<name>.pdf`, default `<first page's document> (merged).pdf`). Each page comes from
  its source's best PDF pages:
  - the PDF view (rendition), which for scans and photos is the searchable PDF with the OCR text
    layer,
  - else the original PDF,
  - else the image wrapped as a page.

  Mixed source types (scan, photo, Word, PDF) work.
- **Combined text and word geometry**. Every page's text travels with it
  (`mergeOf.pageTexts`), and OCR word boxes are copied to the **new page numbers** (`OcrPage`).
  Find-in-document and full-text search cover every page. Nothing is OCR'd or read a second time.
  On rotated pages the word boxes are dropped (the text is kept).
- **Lineage**: `derivedFrom` lists the sources, and `mergeOf` keeps the sources and the page order
  `[{ fileId, page, rotate }]`.
- **Pipeline**: the merged document runs duplicates → classify → index → hand-off like any upload.
  It is never reported as a duplicate of its own sources. The resolved person and type pre-fill
  the AI suggestion, which a person confirms (P10). With AI off, they become the suggestion
  directly.
- **Audit**: `document.merged` with the source ids, the page order (with rotations), the
  confidentiality, `supersede`, and how conflicts were resolved. With supersede, each source also
  gets `document.superseded` (reason `merged`).

## Confidentiality: never reduced

The merged document takes the **strictest** level of its sources (restricted > confidential >
general). The level is stored as `confidentialityFloor`:

- Saving the details with a lower level keeps the floor. A merged medical page can never be filed
  as General.
- A document that is already restricted always goes to the **restricted review queue**, and the AI
  can never lower it (this also protects split parts of a restricted original, P11).
- A user who cannot see a restricted source cannot merge it, or even learn that it exists (404).

## Rules

| Rule | Error |
|---|---|
| At least 2 pages, from at least 2 documents; at most 500 pages and 50 documents | 400 |
| A page can be used once; page numbers must exist; rotation must be 90 / 180 / 270 | 400 |
| Sources must have finished processing; not superseded; not split originals (merge the parts) | 409 |
| Person / type conflict not resolved | 409 `{ conflicts }` |
| Restricted + non-restricted without confirmation | 409 `{ needsAcknowledgement: 'restricted' }` |

## API

| Method | Path | |
|---|---|---|
| POST | `/api/merge/preview` `{ userId, fileIds }` | Sources, conflicts, agreed details, resulting confidentiality, `mixedRestricted` |
| POST | `/api/merge` `{ userId, pages, name?, supersede?, resolution?, acknowledgeRestricted? }` | Create the merged document |

Thumbnails reuse `GET /api/files/:id/pages.pdf` (P11).

## Notes

- **pdf-parse fix**: pdf-parse passed Node Buffers straight to pdf.js. Small Buffers are slices of
  a shared memory pool, so pdf.js read neighbouring bytes and failed at random ("bad XRef entry").
  This affected every small PDF upload. `documents/formats/pdfText.js` now passes a standalone
  copy, and a unit test reads a pooled buffer repeatedly. (pdf-parse also ignores its `version`
  option after the first call, so a version fallback cannot work. That fallback was removed.)
- Partner hand-off: the merged document is sent as a new document. Superseded sources are marked
  in the hub. The partner payload's `supersedesDocumentId` holds one id, so a merge does not claim
  to supersede partner records.

## Tests

`backend/tests/integration/merging.test.js` covers:

- 3 single-page scans → one 3-page document: geometry on pages 2 and 3, search by page-3 text,
  no second OCR, sources untouched
- reorder / rotate / leave out pages, and supersede
- plan validation
- medical + general → restricted, acknowledgement required, cannot be lowered
- person conflict that must be resolved, with the resolution pre-filling the suggestion
- split originals refused (their parts can be merged)

Client: `MergeModal.test.tsx`. A live run merged 3 single-page PDFs into one 3-page document found
by page-3 text, and merged an FMLA certification with a memo into a document that stayed
restricted through AI classification. Scanned-image merges run in tests only, because Textract is
not activated on the AWS account.
