# Email capture (RFP capture feature: "email capture")

Documents e-mailed to the HR intake mailbox reach the system without anyone downloading them.
The City uses Microsoft 365, so production reads a **shared mailbox through Microsoft Graph**.
Development and tests use a **local folder of .eml files**, so no tenant is needed.

## What happens to each message

Every `EMAIL_POLL_SEC` (default 60 s), or on **Check now** in Settings, the service handles the
inbox oldest first:

1. **Seen before?** A Message-ID already imported is skipped, moved to *Processed* and logged as a
   duplicate.
2. **Allowed sender?** The From address must match the **allow-list**, either exact addresses or
   domains (a domain includes its sub-domains, never look-alikes such as `portsmouthva.gov.evil.com`).
   - An **empty allow-list rejects everything**: nothing is accepted until IT says who may send.
   - A message whose `Authentication-Results` header says **`dmarc=fail`** is rejected as a forged
     sender.
   - Rejected messages move to *Rejected* and are logged with the reason.
3. **Stored as an email document** (`source = email`). The existing email handling (P05) then:
   - makes the **message text** the document's text,
   - makes **each real attachment its own linked document**,
   - ignores inline signature images and logos.
4. **Body worth filing?** Setting *Message body*:
   - **auto** (default): the text is filed only when it says something, i.e. at least 80 characters
     and 12 words after removing quoted replies, signatures ("-- "), "Sent from my…" and forwarded
     headers. Otherwise the email stays as a **container**: it links its attachments, but it is not
     searched, classified or handed off by itself.
   - **always**
   - **never** (attachments only)
5. **No double storage**: an attachment whose exact bytes (SHA-256) are already in the system, for
   example a forwarded copy, is **not stored again**. The email records it as skipped ("Already
   captured — same file as …").
   - Two emails carrying the same file and processed at the same moment are decided by a unique
     database claim (`EmailAttachmentClaim`), so exactly one copy is kept.
   - Near-identical content (a re-scan, say) still goes through the normal duplicate check (P08)
     for a person to decide.
6. **Hints for classification**: the subject and body are scanned for employee IDs ("ID 1045",
   "Emp# 3310") and words like W-4, I-9, offer letter, FMLA.
   - They are given to the AI (P10) as `<email_hints>`, explicitly marked as possibly wrong. They
     are **never written into the record as facts**: a person confirms the details.
   - One protective exception: restricted words (FMLA, medical, accommodation, workers' comp,
     investigation, grievance…) put the email and its attachments in the **restricted** queue
     straight away. That can only make a record safer.
7. The message moves to **Processed**. All of a day's emails go into one batch, "Email · mailbox ·
   date" (progress and failures are tracked as for any batch).

Network or storage failures leave the message in the inbox for the next poll. Nothing is lost.

## Audit and privacy

The audit trail and the intake log keep **sender, a hash of the subject, and the Message-ID**,
never the body:
- `email.imported` `{ from, subjectHash, messageId, attachments, bodyFiled }`
- `email.rejected` `{ … reason }`
- `email.duplicate`
- `settings.emailintake_changed`

**Settings → Email intake** (admins) shows the recent log: imported, rejected (with reason) or
already imported.

## Settings

| Where | Setting |
|---|---|
| Settings → Email intake (admin) | Allowed senders, owner of e-mailed documents, message-body option, on/off |
| `backend/.env` | `EMAIL_INTAKE_SOURCE=graph` (or `local`), `EMAIL_POLL_SEC=60`, `EMAIL_MAX_PER_POLL=50` |
| Graph | `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_MAILBOX=hr-intake@portsmouthva.gov` |
| Local testing | `EMAIL_LOCAL_DIR=/path/to/folder`: drop `.eml` / `.msg` files in; handled ones move to `Processed/` / `Rejected/` |

The client secret is read only from the environment and never logged. Graph error messages are
passed on without the token.

## For City IT: Azure app registration with least privilege

1. **Create the shared mailbox** `hr-intake@…` in Exchange Online (no licence needed).
2. **Register an app** in Microsoft Entra ID (Azure AD) → App registrations → *DocP Email
   Intake*.
   - API permissions → Microsoft Graph → **Application** permission **`Mail.ReadWrite`**. ReadWrite
     is needed to move messages to Processed / Rejected; nothing is ever sent. Grant admin
     consent.
   - Certificates & secrets → a client secret (or, preferably, a certificate) → put it in the
     server's secret store as `GRAPH_CLIENT_SECRET`.
3. **Limit the app to that one mailbox.** By default application permissions reach every mailbox,
   so restrict them, in Exchange Online PowerShell:
   - **RBAC for Applications** (recommended):
     ```powershell
     New-ManagementScope -Name "HR intake mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'hr-intake@portsmouthva.gov'"
     New-ServicePrincipal -AppId <app-id> -ObjectId <enterprise-app-object-id> -DisplayName "DocP Email Intake"
     New-ManagementRoleAssignment -App <app-id> -Role "Application Mail.ReadWrite" -CustomResourceScope "HR intake mailbox"
     ```
     With this, remove the tenant-wide Graph `Mail.ReadWrite` consent.
   - or the older **Application Access Policy**:
     ```powershell
     New-DistributionGroup -Name "DocP intake scope" -Type Security -Members hr-intake@portsmouthva.gov
     New-ApplicationAccessPolicy -AppId <app-id> -PolicyScopeGroupId "DocP intake scope" -AccessRight RestrictAccess -Description "DocP may read only the HR intake mailbox"
     Test-ApplicationAccessPolicy -Identity someone.else@portsmouthva.gov -AppId <app-id>   # → Denied
     ```
4. Give DocP `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` and `GRAPH_MAILBOX`, set
   `EMAIL_INTAKE_SOURCE=graph`, and in DocP Settings enter the allowed senders (e.g. the City
   domain and named benefit partners) and the owner.
5. DocP creates the *Processed* and *Rejected* folders under the mailbox Inbox on first use.

**Scan-to-email** (P13): point copiers' "scan to e-mail" at the same intake address and add the
copier's sending address to the allow-list.

Polling is used (every minute). Graph **change notifications** (webhooks) can replace polling
later; they need a public HTTPS endpoint and subscription renewal every few days. They were not
needed to meet the RFP.

## Manual import

Staff can still **drag saved `.eml` / `.msg` files** onto Documents (P04 / P05). They are handled
by the same email processing: body, attachments, inline images ignored.

## Future option: Outlook add-in "Send to HR file"

An Outlook (web / desktop / mobile) add-in could add a **Send to HR file** button. It would send
the selected message (or chosen attachments), with a document type and employee picked in the
add-in, to the DocP upload API under the user's own sign-in. That removes the need to forward to
the shared mailbox. It is not built; it is noted for the proposal.

## Code

`backend/src/features/emailintake/`:
- `sources/` (EmailSource interface: `local.js`, `graph.js`)
- `service.js` (checks, import, poll, settings)
- `hints.js`
- `EmailIntakeLog.model.js`
- `AttachmentClaim.model.js`

Shared pieces:
- `documents/children.js` (duplicate skip, hint inheritance)
- `documents/container.js` (`isContainer`, used by search, hand-off, duplicates, next-incomplete
  and classification)

Client: `features/email/EmailIntakeCard.tsx` in Settings.

## Tests

`backend/tests/integration/emailintake.test.js` covers:

- **the acceptance case**: 3 .eml files produce linked documents from an allowed sender (signature
  logo ignored), reject one non-allowed sender (Rejected folder + log), and skip the forwarded
  duplicate W-4, with folders and audit checked (no body content in the audit)
- the same email in two messages in one poll is stored once
- a repeated Message-ID is skipped
- an empty allow-list and DMARC fail are rejected
- hints reach the AI marked as unverified, an FMLA subject routes to restricted, and nothing is
  written as fact
- admin-only, validated settings
- allow-list matching, hint extraction, meaningful-body detection
- the **Graph client** against a fake HTTP layer: token request, token reuse, inbox listing, MIME
  fetch, Processed folder created once, move call

Client: `EmailIntakeCard.test.tsx`.

**Live run** (local mailbox folder, real S3 and database): 3 messages were picked up by the
background poll within 6 s. 2 were imported and 1 rejected. The W-4 was stored once and the
forwarded copy skipped. The "FYI" forward was kept only as a container. Messages moved to
Processed / Rejected.

**Not verified**: a real Microsoft 365 tenant (none is available here). The Graph calls follow the
documented v1.0 endpoints and are covered by the fake-HTTP test.

## Fixes made along the way

- Partner hand-off is now **serialized per document**. An "accept" and a change event arriving
  together could both send the document before either recorded it, giving the partner two
  records. The second call now waits and re-syncs.
