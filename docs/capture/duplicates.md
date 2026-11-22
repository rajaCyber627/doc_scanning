# Duplicate detection

Audience: HR staff (what happens) and developers.

## What is detected

| Kind | How | Example |
|---|---|---|
| **Same file** | SHA-256 of the original file | the same PDF uploaded twice |
| **Same content** | normalized text is identical, or estimated text similarity ≥ 75% **and** the numbers in both (IDs, dates, amounts) mostly agree | a Word file and its PDF export; the same paper scanned twice |
| **Already in the HR system** | the partner HRDMS reports the same SHA-256 | a file filed before, since removed from the hub |

The **number check** prevents false alarms on HR forms: two W-4s for different
employees share most of their wording but not their IDs and dates.

The **earlier document counts as the original** — only the later copy is flagged, so
two copies in one batch do not flag each other. The check runs in the pipeline's
`dedupe` stage (after text extraction).

## What users see and decide

A flagged document is **Needs review — possible duplicate**, showing what it matches
(file name, who uploaded it, when, "in this batch"). **Compare side by side** opens both
previews. Decisions (each recorded in the audit trail with the reason given):

| Decision | Effect |
|---|---|
| **Keep both** | the flag is resolved; the document becomes ready |
| **Replace existing** | this document becomes the current version; the earlier one is kept, marked *replaced* (`supersededBy`), hidden from lists and search, and the partner is told (`supersedesDocumentId`) |
| **Discard this copy** | the new upload is removed (the earlier copy stays) |

On a batch page, **Keep all** / **Discard all duplicate copies** apply one decision to
every open duplicate in the batch. "Mark as reviewed" cannot skip a duplicate decision.

## Restricted records

If the earlier copy is restricted (medical, FMLA, ADA, WC, ER) and the user lacks the
`restricted` permission, the message is only *"A restricted record with the same
file/content already exists"* — no name, uploader or date, in the message or the API.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `DUPLICATE_CONTENT_SIMILARITY` | 0.75 | text similarity needed for "same content" |
| `DUPLICATE_NUMBER_AGREEMENT` | 0.8 | how much the numbers must agree |

## API

- `GET /api/files/:id/duplicates?userId=` — matches for the compare view
- `GET /api/files/:id/preview` — best preview (PDF view, converted image, or original)
- `POST /api/files/:id/duplicate-decision` `{ userId, action: keep_both|replace|discard, reason }`
- `POST /api/batches/:id/duplicate-decision` — same, for every open duplicate in a batch
- `GET /api/files?includeSuperseded=1` — include replaced versions
