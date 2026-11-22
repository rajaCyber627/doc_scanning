# OCR fixtures

Saved OCR results (Textract response format: `{ "Blocks": [...] }`) used when the
backend runs with `OCR_PROVIDER=fixture` — e.g. for demos while AWS Textract is not
activated on the account.

Lookup order for an uploaded image or scanned PDF:

1. `<sha256 of the file>.json`
2. `<original file name>.json` (e.g. `w4_scan.png.json`)
3. `default.json`

If none exists the document fails with "No saved OCR result…".

To create one: run a real Textract job and save its full response, or build one with
`src/providers/ocr/buildBlocks.js` (see how `w4_scan.png.json` was made).
