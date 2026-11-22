# Automated / assisted classification (RFP capture feature 11)

After text is extracted, the AI suggests the **document type**, the **person** the record belongs to,
the **confidentiality level** and the **type-specific details** (dates, amounts, plan year…). A person
checks the suggestion before anything is filed. Nothing is handed to the partner system until the
details are accepted.

## How a document flows

```
store → hash → extract → dedupe → classify → needs_review ──accept──► ready → index → handoff
                                       │
                                       └─ AI off / failed → staff enter details by hand (P09 panel)
```

1. **Classify stage** (`backend/src/features/classification/service.js` → `runClassification`)
   sends the extracted text, with `[Page n]` markers, to Claude (`claude-opus-5-5`). Long documents
   are cut to the first 30,000 characters, and the screen says so.
2. The reply is **structured JSON** that must match a fixed schema (`classifier.js` → `SCHEMA`). The
   document type must be a key from the city's taxonomy. Every value comes with the **exact quote**
   and page it was read from, plus a confidence from 0 to 1. If the JSON is invalid, the call is
   retried once. After that the document goes to manual entry.
3. **Person match** against the partner HR directory: an employee/applicant ID match wins, then a
   unique name match. Several matches are shown as "several people match" and never picked
   automatically.
4. **Routing**: medical, FMLA, ADA, workers' comp, investigations and grievances go to the
   **restricted queue** (confidentiality `restricted`). Only staff with the `restricted` permission
   or admins see that queue. If the AI is unsure, the document still goes to the restricted queue
   (restricted-first).
5. **Review** (`/review`, or the panel on the file page): confidence badges (green ≥ 85%, amber
   ≥ 60%, red below). Clicking a quote jumps to it in the document. Actions are **Accept all**,
   **Accept & next**, **Edit**, **Move to restricted** and **Release to general** (permitted staff
   only). Accepting writes the details through the normal metadata path (P09). That path validates
   them, records each field in the audit log and records the outcome.

## Settings (admins, Document types page)

| Setting | Default | Meaning |
|---|---|---|
| AI suggestions | on (`CLASSIFICATION_AI_DEFAULT=false` turns the default off) | Off = no document text is sent to the AI; staff enter details by hand |
| Auto-accept | **off** | When on, a suggestion is filed without review only if the person matched by ID and every confidence ≥ threshold. Restricted documents are never auto-accepted |
| Threshold | 0.95 (allowed 0.5–1) | Can also be set per document type (`typeThresholds`) |

## Accuracy

Each accepted suggestion stores a `ClassificationOutcome`: what was suggested, what was kept, and,
field by field, whether the reviewer changed it. `GET /api/classification/accuracy` (admins) reports,
per document type, the share of types and details that reviewers kept. This gives the city real
evidence when it decides whether to turn on auto-accept.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/review-queue?userId&queue=general\|restricted` | staff; restricted needs permission |
| POST | `/api/files/:id/classification/accept` `{userId, metadata}` | staff (edits override suggestions) |
| POST | `/api/files/:id/classification/reassign` `{userId, queue}` | staff; releasing to general needs permission |
| GET / PUT | `/api/settings/classification` | read: all; write: admins |
| GET | `/api/classification/accuracy?userId` | admins |

`POST /api/files/:id/review` refuses with "Accept or correct the suggested details first" while a
classification decision is open.

## AI disclosure (for the RFP response)

- **What is sent**: the extracted text of the document and the city's list of document types. No
  images, no user accounts, no other documents. Sent over TLS to Anthropic's API.
- **Training**: Anthropic does not train models on data sent through its commercial API.
- **Human in control**: by default every suggestion is reviewed by a person. Auto-accept is opt-in,
  needs a high threshold, and never applies to restricted records.
- **Off switch**: one admin setting stops all AI calls. Manual entry works unchanged.
- **Traceability**: every value shows the quote it came from. Accept, edit and move actions are
  written to the audit log. Accuracy is measured from real reviews.
- **Failure-safe**: if the AI is unavailable or unsure, the document waits for manual entry. It is
  never filed with a guess.

## Tests

`backend/tests/integration/classification.test.js` (12 tests: suggestions, ID/name/ambiguous person
match, restricted routing and permissions, invalid-JSON retry, refusal, auto-accept rules, AI off,
accuracy) and `client/src/features/classification/ClassificationPanel.test.tsx`. A live run against
the real API classified an offer letter as `personnel.offer-letters`, matched Priya Patel by
employee ID, quoted the start date and salary, and filed it after Accept all.
