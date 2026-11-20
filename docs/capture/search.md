# Full-text indexing, search and partner hand-off

Audience: developers, the partner vendor's integration team, IT.

## Index record

When a document finishes processing (and whenever it changes later), the hub builds a
search record (`searchdocs` collection) with:

- normalized full text (Unicode-normalized, control characters removed, whitespace
  tidied) — capped like the document text; the full text stays in S3 when longer
- page offsets (`pages: [{ page, start, end }]`) — from OCR pages when available
- language (English / Spanish guess; used for stemming and sent to the partner)
- metadata, document type, batch, folder, status, dates
- **confidentiality** — so restricted records can be hidden

Re-indexing happens automatically on: processing finished, rename/tags, review
accepted, and (later prompts) metadata changes, split and merge — all via the
`document.changed` event. To rebuild everything: `node scripts/reindex-search.js`
(`--no-sync` to skip the partner hand-off).

## Search (`GET /api/search`)

| Parameter | Meaning |
|---|---|
| `userId` | required |
| `q` | words (stemmed: "promotions" finds "promotion"), `"exact phrases"`, `-excluded` words; a single partial word ("Smi") falls back to a substring match |
| `batchId`, `folderId` | limit to a batch / set |
| `status` | `ready`, `needs_review` (comma-separated) |
| `documentType` | exact document type (P09 metadata) |
| `from`, `to` | capture date range (ISO dates) |
| `limit` | 1–200 (default 50) |

Response: `{ mode: 'text' | 'substring' | 'recent', total, results: [{ fileId, fileName,
snippet, highlights: [[start, end]], count, page, status, documentType, createdAt, … }] }`.
Highlights are character ranges in the snippet (the client renders them as text, never
as HTML).

**Restricted documents** (`confidentiality: restricted`) are excluded from results
*and from `total`* for users without the `restricted` permission
(`User.permissions`), so their existence can't be inferred. This becomes role-based
with Entra ID SSO.

Providers: `SEARCH_PROVIDER=mongo` (MongoDB text index, default) or `atlas` (Atlas
Search — stub with the index definition to use; see `src/providers/search/atlas.js`).

## Hand-off to the partner HRDMS

- Sent through `PartnerAdapter.pushDocument` by the pipeline's `handoff` stage, and
  again after every change (same `documentId` ⇒ update; `partnerDocumentId` returned
  by the partner is stored in `File.handoff`).
- **Only `ready` documents are sent.** Documents waiting for review are held back and
  sent when a person accepts them.
- Payload: [`partner-payload.schema.json`](partner-payload.schema.json) (JSON Schema
  2020-12, version `1.0`). It carries file references (original, searchable PDF, full
  text), the index text with page offsets, OCR form fields, metadata, confidentiality,
  parent document (emails/archives) and review history. Tests validate every payload
  against the schema.
- Audit events: `document.handed_off` (first time), `document.resynced` (updates).
