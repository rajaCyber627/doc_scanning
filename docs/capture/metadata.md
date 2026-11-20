# Metadata entry and the HR taxonomy

Audience: HR staff (entering details), HR administrators (managing document types),
developers.

## The taxonomy

Seeded on first start from the RFP (pp. 5–8): **10 record categories** and **74 document
types** (`backend/src/features/metadata/seed-taxonomy.json`). Each document type has:

- its category (→ record category and HR functional area),
- default confidentiality (Medical, FMLA, ADA, Workers' Comp, ER investigations and
  grievances default to **Restricted**),
- default retention category — *placeholders marked "confirm LVA schedule"; the City
  records officer must confirm each against the Library of Virginia General Schedules*,
- extra details, e.g. Offer letter → Start date (required), Salary; FMLA request → Case
  number (required), leave dates; Training completion → Course, Completion date.

Administrators (`User.permissions` contains `admin`, or role `admin`) manage it on the
**Document types** page: add/edit types and their details (text, number, date, pick-list;
required or not), deactivate types, and **export/import JSON** (to sync with the partner's
master list). Import *replace* mode deactivates types missing from the file — documents
already filed keep their type. Every change is audited.

## Standard details (every document)

Document type · employee/applicant (name, employee ID, applicant number, position
title, department, division — filled by picking the person) · effective date · document
date · fiscal year · confidentiality · retention category · HR functional area · record
status · case number · position number — plus the type's own details.

- **Fiscal year** is filled from the effective (or document) date. The City's year starts
  in **July** (`FISCAL_YEAR_START_MONTH=7`): FY2026 = July 2025 – June 2026.
- **Person lookup** searches the HR directory through the partner adapter; the server
  re-checks the picked person, so details can't be spoofed.
- Confidentiality **Restricted** immediately hides the document from users without the
  `restricted` permission (lists, search, details).

## Entering details

The **Document details** panel sits beside the document. Required details are marked `*`;
missing or invalid ones are shown next to the field. Partial saves are fine.
**Ctrl/⌘ + S** saves; **Ctrl/⌘ + Enter** saves and opens the next document that still
needs details. Documents list shows **details missing** until complete.

**Bulk edit**: select documents → *Edit details* → set shared values (type, person,
dates, confidentiality, status, case number) → **Preview changes** (nothing saved) →
**Apply**.

Every change is audited per field: `{ field, from, to }` with who and when
(`metadata.changed`, `metadata.bulk_changed`).

## Hand-off rule

A document is sent to the partner HRDMS **only when its required details are complete**
(`METADATA_REQUIRED_FOR_HANDOFF=true`) — and, as before, only once any review is done.

## API

- `GET /api/taxonomy[?all=1]`, `GET /api/taxonomy/export`, `POST /api/taxonomy/import`,
  `PUT /api/taxonomy/document-types/:key` (admin)
- `GET /api/people?q=` — HR directory search
- `PUT /api/files/:id/metadata` `{ userId, metadata }` → `{ metadata, metadataStatus, errors, changes }`
- `POST /api/metadata/bulk` `{ userId, fileIds, set, apply }`
- `GET /api/metadata/next?userId=&after=` — next document needing details
