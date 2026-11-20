# OCR (optical character recognition)

Audience: developers and IT; the "What users see" section is for HR staff.

## What users see

- Scanned PDFs, photos and TIFFs become **searchable text**. The document view shows
  the scan exactly as it looks, with the recognised text laid invisibly on top — so
  find-in-document highlights words on the scan, and text can be selected and copied.
- The side panel shows how well the text was read (average confidence), whether the
  image was straightened, and the **form fields** found (e.g. *Employee ID → 3310*).
- If the scan is hard to read, the document is marked **Needs review** with the
  reason. After checking it, a person clicks **"I checked it — mark as reviewed"**
  (recorded in the audit trail with who and when).

## Review reasons

| Code | When | Default threshold |
|---|---|---|
| `LOW_CONFIDENCE` | Average word confidence on a page is low | below 80% (`OCR_LOW_CONFIDENCE`) |
| `BLANK_PAGE` | (Almost) no text on a page | fewer than 3 words (`OCR_BLANK_PAGE_WORDS`) |
| `HANDWRITING` | Mostly handwritten page | 30% of words (`OCR_HANDWRITING_RATIO`) |
| `SKEWED` / `ROTATED` | Page tilted or sideways (multi-page scans) | 3° (`OCR_SKEW_DEGREES`) |

## Image clean-up before OCR (single images)

1. **Upright**: phone photos that store "rotate me" in EXIF are rotated for real (and
   the stale tag is removed, so no viewer rotates them twice).
2. **Straighten**: if OCR measures a tilt ≥ 3° (or a sideways/upside-down page), the
   image is rotated and read once more; the straighter result is kept.
The original upload is never changed; the cleaned image is stored next to it.

## Providers

| `OCR_PROVIDER` | Use |
|---|---|
| `textract` (default) | AWS Textract async API. Reads **forms and tables** (AnalyzeDocument FORMS+TABLES); falls back to text-only detection if the account isn't allowed analysis |
| `fixture` | Saved Textract responses from `backend/fixtures/ocr/` — demos/development while Textract is not activated (see its README) |

Set `OCR_FORMS=false` to use the cheaper text-only detection always.

**Textract must be activated on the AWS account.** Until then, scans fail with
"OCR service (AWS Textract) is not activated on the AWS account…" (no retries).

## Storage

- Per page (`OcrPage` collection): text, average confidence, handwriting share, skew,
  every word box (no limit — the old 8,000-word cap is gone), form fields, tables.
- On the document: `ocr` summary (provider, pages, confidence, form fields) and
  `reviewReasons` / `resolvedReviewReasons` (history).
- Detected tables also go into `tablesCsv`, so Q&A can use them.
- `GET /api/files/:id/geometry[?page=N]` returns word boxes for highlighting.
- `POST /api/files/:id/review` accepts a "needs review" document.
