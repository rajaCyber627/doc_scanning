# Supported file types (electronic document import)

Audience: HR staff (what can be uploaded), IT (server setup), developers.

## What can be uploaded

| Type | Extensions | How the text is read | How it is shown |
|---|---|---|---|
| PDF | `.pdf` | Text layer; OCR if scanned | The PDF itself |
| Photos / scans | `.png` `.jpg` `.jpeg` | OCR | The image |
| Multi-page scans | `.tif` `.tiff` | OCR (all pages) | PDF view, one page per scan page |
| iPhone photos | `.heic` `.heif` | Converted to JPEG, then OCR | Converted JPEG |
| Other images | `.gif` `.bmp` | Converted to JPEG, then OCR | Converted JPEG |
| Word | `.docx`, `.doc` (97-2003) | Document text | PDF view |
| Rich Text / OpenDocument | `.rtf`, `.odt` | Document text | PDF view |
| Excel | `.xlsx`, `.xls` (97-2003) | Every sheet as rows (also used for Q&A tables) | PDF view |
| PowerPoint | `.pptx` | Slide text, in slide order | PDF view |
| Text | `.txt` `.md` `.csv` | As is | PDF view |
| Email | `.eml`, `.msg` (Outlook) | Headers + message body | PDF view; **each attachment becomes its own linked document** |
| Archive | `.zip` | List of contents | **Each file inside becomes its own linked document** |

The original file is always kept unchanged; previews and converted images are
separate copies, deleted together with the document.

## Safety rules

- The file's **content must match its extension** (checked at upload). A renamed
  program fails with "does not contain PDF data…".
- **Never imported**, even from inside emails or ZIPs: programs and scripts
  (`.exe .dll .bat .cmd .msi .js .vbs .ps1 .sh .jar .lnk …`) and macro-enabled Office
  files (`.docm .xlsm .pptm`). They are listed under "Not imported" with the reason.
- **Password-protected** files fail with a clear message (Office, PDF, ZIP entries).
- **ZIP limits** (zip-bomb protection): at most 1,000 files, 500 MB uncompressed in
  total, each file within the upload limit, and extreme compression ratios are refused.
  Sizes are re-checked while unpacking, so a lying archive header can't bypass them.
- **Nesting**: an email inside a ZIP (or a ZIP inside a ZIP) is expanded one level;
  deeper nesting is listed as not imported.
- At most 200 attachments/files are imported per email or archive.
- Inline images in an email's HTML (signatures, logos) are not treated as attachments.

## PDF previews and LibreOffice (server setup)

Office documents get a PDF preview. Two methods:

| Method | When | Fidelity |
|---|---|---|
| **LibreOffice** (recommended in production) | `soffice` is installed or `SOFFICE_PATH` is set | Looks like the original (layout, tables, fonts) |
| Built-in text PDF (fallback) | LibreOffice not installed | Text only, but searchable (find-in-document works) |

The server checks the usual locations (`/usr/bin/soffice`, `/usr/bin/libreoffice`,
`/opt/libreoffice/program/soffice`, macOS app). For Amazon Linux / EC2 ask IT to install
a headless LibreOffice build (e.g. the official LibreOffice RPM bundle) and set
`SOFFICE_PATH` if it lives elsewhere. Each conversion runs with its own temporary
profile and a 2-minute timeout; failures fall back to the text preview.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `FORMATS_MAX_CHILDREN` | 200 | Attachments / ZIP files imported per container |
| `FORMATS_MAX_CONTAINER_DEPTH` | 2 | How deep nested emails/ZIPs are expanded |
| `FORMATS_MAX_ARCHIVE_ENTRIES` | 1000 | Files allowed in one ZIP |
| `FORMATS_MAX_ARCHIVE_MB` | 500 | Total uncompressed size of one ZIP |
| `FORMATS_MAX_COMPRESSION_RATIO` | 200 | Refuse entries (>10 MB) compressed more than this |
| `FORMATS_MAX_SHEET_ROWS` | 20000 | Rows read per spreadsheet sheet |
| `FORMATS_MAX_RENDITION_PAGES` | 300 | Pages in a text PDF preview |
| `SOFFICE_PATH` | (auto) | LibreOffice binary for high-fidelity previews |

## Libraries used

`mammoth` (.docx), `word-extractor` (.doc), SheetJS 0.20.3 from the official
distribution (.xlsx/.xls — the npm 0.18.5 build has a known vulnerability with crafted
files), `jszip` (.odt/.pptx), `mailparser` (.eml), `@kenjiuno/msgreader` (.msg),
`yauzl` (safe ZIP reading), `heic-convert`, `jimp`, `utif` (images), `pdf-lib` (previews).
