# Uploads — how they work and how to configure storage

Audience: developers and the IT team that manages the S3 bucket.

## Flow

1. **Create** — `POST /api/uploads` `{ userId, fileName, sizeBytes, folderId?, hints? }`.
   The server checks type (by extension), size (default limit 100 MB) and folder
   ownership, then returns where to send the bytes:
   - `url` — one presigned S3 `PUT` (files ≤ 10 MB), or
   - `multipart.parts[]` — presigned part URLs (files > 10 MB, 8 MB parts, sent 3 at a time), or
   - `proxyUrl` — `PUT` the bytes to the server, which streams them to S3.
2. **Send bytes** — the browser shows per-file progress.
3. **Complete** — `POST /api/uploads/:id/complete` `{ userId, parts? }`. The server
   checks the object exists, the size matches, and the **content really is the claimed
   type** (magic-byte sniffing, so a renamed `.exe → .pdf` is rejected). Only then is a
   document created and queued for processing.
4. **Abort** — `POST /api/uploads/:id/abort` cancels and deletes anything stored.

Every step is audited: `upload.started`, `upload.completed`, `upload.failed`.
Failed processing can be retried with `POST /api/files/:id/retry` (resumes at the
failed stage; the upload is not repeated).

## Transports

| Setting `UPLOAD_TRANSPORT` | Behaviour |
|---|---|
| `auto` (default) | Browser tries direct-to-S3; if the bucket blocks the browser (no CORS rule) it falls back to the server proxy and remembers that for the session |
| `direct` | Always direct to S3 (requires the CORS rule below) |
| `proxy` | Always through the server |

**Production note:** behind Vercel the proxy path is limited to ~4.5 MB per request,
so production should use `direct` with the CORS rule below. Locally there is no limit.

## Required S3 bucket CORS rule (for direct uploads)

Ask whoever administers the bucket to add (adjust origins per environment):

```json
[
  {
    "AllowedOrigins": ["https://cndocp.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

`ExposeHeaders: ETag` is required for multipart uploads (the browser must read each
part's checksum).

## Recommended S3 lifecycle rule

Abandoned multipart uploads cost storage until removed. Add a lifecycle rule:
*Abort incomplete multipart uploads after 1 day*. Pending upload sessions in the
database expire on their own after 24 hours (`UPLOAD_SESSION_TTL_HOURS`).

## Other settings

| Variable | Default | Meaning |
|---|---|---|
| `UPLOAD_MAX_MB` | 100 | Largest accepted file |
| `UPLOAD_MULTIPART_MB` | 10 | Files above this use multipart |
| `UPLOAD_PART_MB` | 8 | Part size (S3 minimum 5) |
| `UPLOAD_PRESIGN_SECONDS` | 3600 | How long upload URLs stay valid |
| `UPLOAD_LEGACY_ROUTE` | true | Keep the old `POST /api/files` form upload |
| `TEXT_MAX_STORED_CHARS` | 1,000,000 | Longer extracted text is kept in full in S3; a capped copy is stored on the record |
