# Scanning (RFP capture feature: "scanning")

HR can scan paper straight into the system, from a phone, tablet or laptop camera, or from the
City's existing office scanners and copiers. **No software is installed on any PC.**

| Way | For | Source on the document |
|---|---|---|
| **Scan with camera** (`/scan`) | A few pages at a desk or in the field | `camera` |
| **Scanner folder** (hot folder) | Office scanners / multifunction copiers, any volume | `scanner` |
| **Scan-to-email** | Copiers that can only e-mail | `email` (P15) |

Every scanned document then goes through the normal pipeline: OCR (P06), separator sheets and
splitting (P11), duplicates (P08), classification (P10), indexing and hand-off.

## 1. Scan with camera

A mobile-friendly page (menu → **Scan with camera**).

1. **Live camera** (rear camera on phones). A green outline shows the page it has found, a few
   times per second.
2. **Capture**: the page edges are found automatically. The page is the largest bright region
   against a darker background, and its four outer corners are used. If no clear edge is found,
   the whole photo is used. Either way the user can **drag the four corners**.
3. **Keep page**:
   - **perspective correction** (a homography maps the four corners to a flat rectangle, with
     bilinear sampling),
   - then the chosen **look**:
     - *Document* (black and white): divides by the blurred background, which removes shadows
       and uneven light.
     - *Grayscale*.
     - *Color*: for photos, colored stamps and highlights.
4. Repeat for more pages. Pages can be **reordered** (← →), **retaken** (↺) or **deleted**.
5. **Save as PDF**: the browser builds one PDF (pdf-lib, Letter width) and uploads it through the
   normal upload flow (P02) with `source = camera`. The audit trail records `document.captured`
   `{ source: 'camera', device: 'iPhone · Safari', pages }`. The server accepts only `upload` or
   `camera` from a browser. `scanner` / `email` / `import` are set by the server itself.
6. **Fallback**: when camera access is denied or not available (camera access needs HTTPS), the
   page offers the device's photo picker (`capture="environment"`). On phones this opens the
   camera app. Each photo then gets the same corner / perspective / filter steps.

The image maths is in `client/src/features/scan/scanMath.ts`, as pure functions with unit tests
(corner detection on a tilted page, an exact homography, shadow removal).

## 2. Scanner folders (hot folders)

Office scanners and copiers already "scan to folder" (SMB/network share) or can be pointed at
cloud storage. An administrator maps folders to staff in **Settings → Scanner folders**.

| Field | |
|---|---|
| Name | Shown in the audit trail as the device, e.g. "HR copier" |
| Kind | **Network folder**: a sub-folder of the scanner share mounted on the server at `HOTFOLDER_ROOT`. **S3 prefix**: e.g. `scanners/hr-copier/` in the document bucket |
| Owner | The staff member whose documents these become |
| Batches | **One batch per sub-folder** (e.g. `hr/box-12/` → batch "Scanner · HR copier · box-12"; files directly in the folder → one batch per day), **one per day**, or **none** |

How it runs (`backend/src/features/hotfolder`):

- Every `HOTFOLDER_INTERVAL_SEC` (default **30 s**) each enabled folder is checked. A file
  dropped in is imported **within a minute**. Admins can also click **Check now**.
- A local file that changed in the last `HOTFOLDER_STABLE_SEC` (5 s) is left for the next check,
  so a scanner still writing a large file is never read half-written. S3 uploads are atomic.
- Each file gets the same checks as an upload: type, real content, size limit, and programs are
  refused. It is stored, becomes a document (`source = scanner`,
  `metadata.capture = { device, folder, path }`) and starts the pipeline.
- The folder shows what happened. Imported files move to `.imported/<date>/` and refused files to
  `.rejected/<date>/`. Every attempt is recorded (`HotFolderImport`: imported, or rejected with the
  reason; **Recent files** in Settings). A file version (path + size + time) is never imported
  twice.
- Audit: `document.captured` `{ source: 'scanner', device, folder, fileName, batchId }`,
  `capture.rejected`, `batch.created`, `settings.hotfolders_changed`.
- Safety:
  - local folders must resolve **inside** `HOTFOLDER_ROOT`, so `../` is refused and admins cannot
    point at other server paths
  - only one sub-folder level is read
  - hidden and temporary files (`.x`, `~x`) are ignored
  - only administrators can change the folders

Server settings (`backend/.env`):

```
HOTFOLDER_ENABLED=true          # background checking (false = only "Check now")
HOTFOLDER_INTERVAL_SEC=30
HOTFOLDER_ROOT=/mnt/hr-scans    # where the scanner share is mounted (network folders)
HOTFOLDER_STABLE_SEC=5
HOTFOLDER_MAX_FILES=200         # per folder per check (large drops continue next check)
```

### Setting up a copier (City IT)

1. Create a share, e.g. `\\fileserver\hr-scans`, and mount it on the DocP server at
   `HOTFOLDER_ROOT` (read/write for the DocP service account, so files can be moved to
   `.imported`).
2. On the copier, add a **scan-to-folder** destination `\\fileserver\hr-scans\hr`. Optionally
   add one per box or project as sub-folders.
3. Recommended copier profile: **300 dpi, PDF, duplex, black-and-white** (color only when
   needed), one file per stack. Put a separator sheet between documents (P11) to have stacks cut
   automatically.
4. In DocP: Settings → Scanner folders → add "HR copier", Network folder, path `hr`, owner, Save.

For S3, give the copier's cloud connector (or an AWS Transfer Family SFTP endpoint) write access
to `s3://<bucket>/scanners/<name>/` only.

## 3. Scan-to-email

For devices that can only e-mail, use the intake mailbox from **P15 (email capture)**: the
copier's "scan to e-mail" sends to the HR intake address, and each attachment becomes a
document. The setup is documented with P15.

## 4. Scan settings guidance

The camera page always shows the "Getting a good scan" panel:
- **Camera**: flat page, even light, darker surface, phone straight above, no flash glare.
- **Office scanners**:
  - **300 dpi**, **PDF**
  - **black-and-white** for text; **color only** for photos, stamps and highlights
  - **duplex** when backs are printed
  - remove staples
  - save to the HR scanner folder, with separator sheets between documents

## 5. Option: direct browser scanner control (TWAIN / WIA), not built

For the proposal: if the City wants to start a scan from the web page (choose a scanner, set dpi /
duplex, preview), commercial SDKs provide it:

| SDK | How it works | Notes |
|---|---|---|
| Dynamsoft **Dynamic Web TWAIN** | JavaScript library + a small local service on each PC that talks to TWAIN/WIA/ICA/SANE drivers | Most widely used; per-client or per-server licence; supports Windows/macOS/Linux |
| VintaSoft **Web TWAIN** | Same model (local service + JS) | Lower cost; Windows-focused |
| Asprise **Scanner.js** | JS + local helper | Simple API; smaller feature set |

Trade-offs: every scanning PC needs the vendor's local service installed and kept updated. That
is software on each PC, which this RFP response avoids. Licensing is per seat or per server. The
benefit is scanner control from the browser. Both camera and scanner-folder capture already meet
the RFP without it. If chosen later, the SDK's output (PDF) would go through the same upload API
with `source = scanner`, so the rest of the system does not change.

## Tests

- `backend/tests/integration/scanning.test.js` covers:
  - admin-only settings, path confinement, owner checks
  - local folder import with batch per sub-folder, move to `.imported` / `.rejected`, reasons,
    audit, no double import
  - half-written files waiting
  - a missing folder not stopping others
  - S3 prefix import
  - camera source + device audit, and that a client cannot claim `scanner`
- `client/src/features/scan/scanMath.test.ts` (image maths) and `ScanPages.test.tsx` (camera
  fallback, scanner-folder settings).
- Live run: a PDF dropped into the mounted share was imported by the background check in 18 s
  (`source = scanner`, batch "Scanner · HR copier · box-7", file moved to `.imported`). The real
  S3 bucket could be listed for an S3 scanner folder.
- Not verified live: capturing on a physical phone (no device available in this environment), and
  OCR of camera / scanner images (Textract is not yet activated on the AWS account). The PDF is
  built and uploaded through the tested upload path, and OCR of scanned PDFs is covered by the
  P06 tests.
