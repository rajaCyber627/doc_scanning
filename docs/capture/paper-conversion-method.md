# Converting Paper Personnel Records to Electronic Records — Recommended Method

*City of Portsmouth, VA · RFP #340-27-YE · HR Document Management System*

> **Items marked ⚑ need confirmation** with the City or the Library of Virginia (LVA) before the
> plan is final: mainly the volume of paper and current LVA requirements. Legal references were
> checked against the Code of Virginia (law.lis.virginia.gov) and LVA publications on
> 21 November 2026.

---

## One-page summary (for the proposal)

**Our recommendation:** convert the active and recently separated employee files
("backfile") in a planned, box-by-box project, and start **day-forward** capture on go-live day,
so the paper backlog stops growing. Older inactive files are scanned **on demand** or left on paper
until they can lawfully be destroyed. We do not scan records the City may already destroy under
its Library of Virginia retention schedule.

**How it works:**

1. **Inventory first.** Count boxes, folders and pages, assess condition, and set priorities:
   active employees, then retirees and separated employees still within retention, then
   applicants. Records past retention are listed for the City to approve for destruction instead.
2. **Prepare** each folder: remove staples, repair pages, put a printed **separator sheet** in
   front of each document. The sheet's barcode carries the document type and employee ID. A
   chain-of-custody log follows every box.
3. **Scan** at **300 dpi**, duplex, black-and-white for text and color only when needed, saved
   as PDF/A. The City's existing copiers work, through a watched network folder, so no software
   is installed on any PC.
4. **The Capture Hub** reads every page (OCR) and cuts each stack into documents at the separator
   sheets. AI suggests each document's type, employee and details, and **a person confirms every
   suggestion**. Medical, FMLA, ADA, workers' compensation and employee-relations records are
   routed to a **restricted queue** that only authorized staff can see.
5. **Quality control:** a random sample (10% by default) of every box is compared with the paper.
   Failures are rescanned.
6. **Reconciliation:** each box gets a report proving that every page received is in a document
   (or was a separator sheet). **0 missing pages** is required before the City signs off the box.
7. **Paper disposition** follows the City's LVA retention schedule (GS-03, *Personnel Records*)
   and LVA's guidance that a quality-controlled image may become the record copy. Destruction is
   certified on LVA's **RM-3** form, and never while a legal, audit, investigation, grievance,
   FOIA or administrative hold applies.

**Who does what:** the City decides priorities, approves mappings, sign-offs and destruction, and
provides HR reviewers for confirmation. We configure the system, train staff, run or supervise
preparation and scanning (the City's staff, our team, or a bureau, as the City prefers), run QC
and produce the reconciliation and certification package.

**Timeline:** driven by page volume ⚑. For example, 1.25 million pages takes about **7–8 months**
with 4 preparers, 1 scanning station and 4 reviewers (worked example in §12).

---

## 1. Summary

Paper conversion succeeds when it is treated as a **records project with evidence**, not just a
scanning job. Our method:

- decides first what should be scanned at all
- prepares paper so documents separate themselves (separator sheets)
- scans to a fixed standard
- lets the Capture Hub do the reading and sorting, with a person confirming each result
- proves completeness box by box (QC sample + page reconciliation)
- ends with a lawful, documented disposition of the paper

Everything runs through the same software the City will use every day afterwards, so the day the
backfile ends, the day-forward process is already familiar.

## 2. Approach options and our recommendation

### 2.1 Backfile conversion vs day-forward scanning

| | Backfile (existing paper) | Day-forward (new paper from go-live) |
|---|---|---|
| What | Scan the existing filing cabinets and boxes | Scan new paper as it arrives |
| Pros | Removes the paper and gives immediate electronic access to history | Cheap, simple, stops the backlog growing |
| Cons | The largest cost and effort; needs preparation and QC | History stays on paper |

**Recommendation:** **both.** Day-forward from go-live day, and a prioritized backfile (§3). For
day-forward details see §11.

### 2.2 Who scans

| Option | Pros | Cons | Best when |
|---|---|---|---|
| **City staff with our software** (in-house) | Records never leave City premises; lowest cash cost; staff learn the system | Takes HR staff time; slower | Smaller volumes; very sensitive files |
| **Our scanning team on site** | Experienced; fast; records stay on site; City staff only review | Higher cost; needs secure space | Medium–large volumes on a deadline |
| **Scanning bureau** (off site) | Highest throughput; bureau equipment | Records leave the building (custody, insurance, transport risk); less control | Very large, mostly inactive volumes |

**Recommendation:** **on-site scanning** (our team, or City staff after training) for active and
restricted files. A vetted bureau is optional, only for large volumes of inactive files ⚑. In
every option the output goes through the same Capture Hub, QC and reconciliation, so quality
does not depend on who scans.

### 2.3 Scan everything vs scan on demand (inactive files)

| | Scan everything | Scan on demand |
|---|---|---|
| Pros | One project, everything searchable | Pays only for files actually needed |
| Cons | Pays to scan files nobody will open, or that will soon be destroyable | Requests wait for scanning; paper remains |

**Recommendation:** scan **active** employees and files with **long remaining retention**.
Inactive files with short remaining retention stay on paper until destruction, and are scanned
**on demand** (scan-on-request takes minutes with the camera or a copier). The inventory (§3)
gives the numbers for this decision.

## 3. Discovery and inventory

1. **Count**: boxes, drawers, folders, and an estimated page count per box (weigh or measure:
   ~200–250 pages per inch is a common rule of thumb ⚑). Record location and owner.
2. **Assess condition**: staples and clips, fragile or torn pages, odd sizes, photographs, bound
   items, carbon or thermal paper, mould or water damage (set aside for special handling).
3. **Prioritize**:
   1. active employees
   2. retirees and separated employees still within retention
   3. applicants and recruitment files
   4. other HR series

   Within each group, by the **retention status** of the series under the City's LVA schedule.
4. **Identify what may already be destroyed.** For each records series the City's records
   officer compares the dates with **LVA General Schedule GS-03 *Personnel Records*** (current
   revision June 2026 ⚑ verify series-level periods). Records past retention and not under any
   hold (§9) go on a destruction list for City approval instead of being scanned.
5. **Electronic records already on shared drives** are inventoried by the migration tool (hash,
   type, duplicates) and imported without printing (RFP Data Migration; see `shared-drives.md`).

Output: an **inventory workbook** (boxes, page estimates, condition, priority, retention status)
and a **destruction-candidate list** for City approval.

## 4. Preparation

| Step | Detail |
|---|---|
| Unfasten | Remove staples, clips and bindings; unfold; flatten curled pages |
| Repair | Tape tears on the back (archival tape); put fragile pages in clear sleeves or scan them on the flatbed |
| Odd sizes and photos | Small items mounted on a carrier sheet or scanned flatbed; photos and color forms flagged for color scanning; oversize items scanned separately and linked |
| Remove non-records | Sticky notes are transcribed or scanned as their own page if they carry information; blank dividers, duplicates of printed forms and envelopes are removed (with a rule agreed with the City) |
| **Separator sheets** | A printed sheet in front of each document, printed from the system. Its **QR code and printed code** carry the document type and employee ID. The system cuts the stack there, removes the sheet and pre-fills the details. Without sheets, AI suggests the cuts for a person to confirm. |
| Box label | Each box has an ID, used as the scan batch's **box ID** and as the scanner sub-folder name |
| **Chain of custody** | A log per box: who took it, when, from where to where, its condition, its return or disposition. It is signed at each hand-over. |
| Secure storage and transport | Locked area during the project; boxes sealed for any transport; no records left unattended |

## 5. Scanning standards

| Setting | Standard |
|---|---|
| Resolution | **300 dpi** minimum (LVA *Digital Imaging Guidelines* use 300 PPI as sufficient for most originals). 400–600 dpi for very small print or poor originals |
| File format | **PDF/A** for retention (LVA: "preferable for long-term storage is PDF/A"). The system adds a searchable text layer and keeps the original scan unchanged |
| Sides | **Duplex**. Blank backs are detected and flagged for removal by the system |
| Color | **Black-and-white** for typed or printed text; **grayscale** for faint originals, pencil or signatures that drop out; **color** only for photographs, colored stamps, highlighting or color-coded forms |
| Files | One PDF per box section (stack), split by separator sheets; or one PDF per document where scanned singly |
| Naming | `<BoxID>-<sequence>.pdf` at capture. The system then names each document after its type and employee; the original file name is kept |
| Image checks | Straightness (deskew), orientation, cropping, legibility. The system's OCR quality check flags blank, faint, skewed, sideways and handwritten pages for review |
| Equipment | City copiers or production scanners, set up once with these profiles (see `scanning.md`) |

## 6. Processing in the Capture Hub

What happens automatically after scanning, and where people decide:

1. **Arrival**: copier scan-to-folder, upload, or camera. Each box is a **scan batch** with its
   box ID and expected page count.
2. **OCR**: every page is read, word positions are kept, and quality is checked per page.
3. **Splitting**: cut at separator sheets, which are removed. Without sheets, AI suggests the cuts
   and a person accepts or adjusts them in the page view.
4. **Duplicate detection**: the same file or the same content already in the system (including
   the partner system) is flagged. A person decides: keep both, replace, or discard.
5. **AI-assisted classification**: the AI suggests the document type, employee and key details,
   showing the exact text it relied on and a confidence score. **A person confirms or corrects
   every suggestion**; auto-acceptance is off. Separator-sheet details pre-fill the suggestion.
6. **Restricted handling**: anything that may be medical, FMLA, ADA, workers' compensation or
   employee relations is marked **Restricted** immediately. It goes to a restricted review queue
   visible only to authorized staff. Restricted status is never lowered by the AI.
7. **Metadata**: the City's taxonomy (record category, document type, employee, dates,
   confidentiality, retention category) is completed and checked before the document is handed
   to the records system.

## 7. Quality control

| Item | Standard |
|---|---|
| Sample | **10% of documents per box** (default; adjustable per batch; minimum 1), drawn at random by the system |
| What reviewers check | All pages present and in order, against the paper; legible; correctly cut (no merged or split documents); correct type, employee and confidentiality; restricted documents in the restricted queue |
| On failure | The reviewer records why (e.g. "page 2 cut off"). The document is marked **Rescan**, rescanned from the paper, and checked again |
| **Acceptance** | A box is accepted when **0 pages are missing** in reconciliation, **all sampled documents pass** (or failures are rescanned and pass), and no review items are open ⚑ City to confirm thresholds |
| Escalation | If more than 2 sampled documents in a box fail ⚑, the whole box is re-checked |

LVA requires "a quality control process in place to certify that the imaged records are visually
inspected for legibility and integrity, as well as an indexing system" (*Digital Imaging
Guidelines*). The sample, the review queue and the taxonomy index provide this.

## 8. Reconciliation and certification

For every box the system produces a **reconciliation report** (CSV and PDF):

- pages expected, received, **in documents**, removed (separator and blank pages) and **missing**
- documents per type and per employee
- exceptions: failed files, rescans, possible duplicates, undecided items
- the QC sample and its results
- who scanned, reviewed and generated the report, and when

**Certification:** the City's HR records lead reviews the report and signs off the box: 0
missing pages, QC passed, exceptions resolved. The signed reports form the project's
certification package. They also support the accuracy assurance required by Code of Virginia
§ 42.1-85(B): a converted record must be "an accurate copy of the original record".

## 9. Disposition of the paper

**Rules** (Virginia Public Records Act, Code of Virginia Title 42.1, Ch. 7):

- An agency "may retain any public record in an electronic medium, provided that the record
  remains accessible for the duration of its retention schedule" (§ 42.1-86.01). A converted record
  "shall have the force of the original" (§ 42.1-85(B)).
- LVA's *Digital Imaging Guidelines* (2008, links updated 2018) state that "the imaged copy may
  be used as the record copy and the paper original can be destroyed". The imaged copy must be
  accurate, accessible for its whole retention period, quality-controlled and indexed.
  **Consult the City's LVA Records Management Analyst before reformatting permanent records.**
- A public record may be destroyed only when (§ 42.1-86.1(A)):
  - it is on an approved retention schedule,
  - the retention period has expired,
  - a **Certificate of Records Destruction (RM-3)** has been completed and approved by the
    City's designated **records officer** (designated on LVA form RM-25), and
  - **no litigation, audit, investigation or FOIA request is pending.**

  On LVA's online RM-3, an **Approving Official** affirms that no holds are in place or anticipated.
  The original certificate goes to the Library of Virginia.

**Our recommended practice:**

1. **Paper whose retention has expired** (from the inventory): destroyed by the City with an
   RM-3, without scanning.
2. **Scanned paper**: kept in secure storage for a **verification period** after the box is
   certified (e.g. 90 days ⚑), so the City can spot-check. Then destroyed under an RM-3 by
   certified secure shredding with a certificate of destruction from the shredding vendor. ⚑
   Confirm with the LVA analyst how scanned originals are reported on the RM-3.
3. **Never destroyed while any hold applies**: legal, audit, investigation, **grievance**, FOIA
   or administrative. The City's records officer or counsel provides the hold list before each
   destruction batch. Held files are pulled and kept.
4. **Permanent or historically significant records** (if any in HR series ⚑): consult LVA before
   reformatting. The originals may be retained.
5. Files with Social Security numbers and other identifying information must be destroyed within
   six months after their retention period ends (§ 42.1-86.1(C)). Note this when scheduling.

## 10. Security and confidentiality during conversion

- Project staff are **background-checked** ⚑ (City standard) and sign confidentiality agreements.
- Work happens in a **secure, access-controlled area**. Paper is never left unattended, and no
  personal phones are used at the scanning station.
- **Restricted records** (medical, FMLA, ADA, workers' compensation, employee relations) are
  prepared and reviewed only by authorized staff. In the system they are restricted from the
  moment they are read.
- Scans go **directly into the system** (encrypted transfer, encrypted storage); no copies are
  kept on scanners or PCs. Copier hard drives are wiped per City IT policy ⚑.
- **Audit trail**: the system logs every capture (device, folder), split, merge, AI suggestion,
  review decision, QC result, report and access. The chain-of-custody log covers the paper.

## 11. Day-forward process (after go-live)

| New paper arrives… | What staff do |
|---|---|
| A few pages at a desk | **Scan with camera** (phone or tablet) or the nearest copier into the HR scanner folder |
| A stack | Put separator sheets in front of each document, scan to the HR scanner folder |
| By e-mail | Arrives automatically through the HR intake mailbox |
| Electronic files | Drag into the system |

The same OCR, splitting, classification-with-review and restricted routing apply. The originals
are kept for a short verification period ⚑ (e.g. 30 days), then destroyed under the retention
schedule with an RM-3, unless held.

## 12. Timeline and staffing model

The City's paper volume is not yet known ⚑, so the plan uses a formula, re-run after the
inventory.

**Inputs:** P = total pages; D = average pages per document; productivity rates per person-day
(7 productive hours). The planning rates below are typical for HR folders ⚑ and are validated in
the pilot:

| Activity | Planning rate |
|---|---|
| Preparation (unstaple, repair, separator sheets) | **2,000 pages** per preparer-day |
| Scanning (production scanner, including loading and checks) | **12,000 pages** per station-day |
| Review (confirm AI suggestions; separators pre-fill most) | **280 documents** per reviewer-day (~40 per hour) |
| QC sample (10%) | **250 documents** per QC-day |

**Days = work ÷ (rate × people).** The longest of the parallel activities sets the pace.

**Worked example** (illustrative): 500 boxes × 2,500 pages = **P = 1,250,000 pages**; D = 8
pages, so **156,250 documents**.

| Activity | Effort | Staff | Working days |
|---|---|---|---|
| Preparation | 1,250,000 ÷ 2,000 = 625 person-days | 4 | ~156 |
| Scanning | 1,250,000 ÷ 12,000 = 104 station-days | 1 station | ~104 |
| Review | 156,250 ÷ 280 = 558 person-days | 4 | ~140 |
| QC | 15,625 ÷ 250 = 63 person-days | 1 (part time) | ~63 |

Run in parallel, this is about **156 working days, roughly 7–8 months**, plus about 4 weeks for
inventory, setup and a pilot box. Adding a fifth preparer brings it to about 6 months. If most
boxes are inactive files kept on paper (§2.3), the scanned volume and the timeline shrink.

**Pilot:** the first 2–3 boxes are converted end to end to confirm rates, separator use, QC
thresholds and the reconciliation format before full production.

## 13. Roles and responsibilities

| Task | City | Vendor |
|---|---|---|
| Name records officer / project lead; provide retention schedule and hold list | ✔ | |
| Inventory | Assist, access | Lead, workbook |
| Approve priorities, destruction candidates, mapping of folders to document types | ✔ | Propose |
| Secure workspace, storage, transport approvals | ✔ | Requirements |
| Preparation and scanning | Option A (in-house) | Option B (our team) / bureau management |
| System configuration, separator sheets, scanner profiles, training | | ✔ |
| Review and confirm AI suggestions; restricted review | ✔ (HR staff) | Support; our team only where authorized |
| QC sampling and rescans | Participate | Lead |
| Reconciliation reports | Sign off | Produce |
| RM-3 destruction certificates and destruction | ✔ | Prepare lists |
| Day-forward procedures | Adopt | Document, train |

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Volume larger than estimated | Inventory first; formula-based plan; scan-on-demand for inactive files |
| Missing or out-of-order pages | Preparation checklist; page reconciliation per box (0 missing required); QC sample |
| Mis-filed documents (wrong employee or type) | Separator sheets carry the employee ID; AI suggestion with evidence; human confirmation; name/ID mismatch warnings |
| Exposure of restricted information | Restricted routing on first read; authorized staff only; secure area; audit trail |
| Destroying records under hold or too early | Destruction only via RM-3 after the verification period; hold list checked per batch; records officer approval |
| Poor originals (faint, carbon, thermal) | Grayscale or higher dpi; OCR quality flags; rescan |
| Staff time pulled from HR work | On-site vendor team option; AI pre-fill reduces review time; phased schedule |
| Chain-of-custody gap | Signed log per box; sealed transport; locked storage |
| LVA requirements change | ⚑ confirm with the LVA analyst at kick-off and before the first destruction |

## 15. Assumptions and questions for the City

**Assumptions** (⚑ to confirm):
- HR paper is mainly letter/legal-size typed forms in folders, in reasonable condition.
- The City has a designated records officer (LVA RM-25) and uses LVA GS-03 for personnel records.
- City copiers can scan to a network folder at 300 dpi duplex to PDF.
- HR staff are available to confirm AI suggestions and handle restricted files.
- Planning rates in §12 are confirmed in the pilot.

**Questions:**
1. How many boxes or drawers of HR records are there, where, and how many active vs inactive
   employees?
2. Which series does the City consider permanent or historically significant?
3. Who is the City's records officer, and who will act as the RM-3 Approving Official?
4. Are there current legal, audit, investigation, grievance or FOIA holds on any HR files?
5. Preferred scanning option: in-house, our on-site team, or a bureau for inactive files?
6. Required verification period before paper is destroyed?
7. Should originals of any category (e.g. signed agreements, I-9s) be kept regardless?
8. Background check standard for project staff?
9. Is space available for a secure on-site scanning room?
10. Is the City's LVA Records Management Analyst available for a kick-off consultation?

---

**Sources checked (21 Nov 2026):**
- Code of Virginia §§ 42.1-85, 42.1-86.01 and 42.1-86.1 (law.lis.virginia.gov)
- LVA locality general schedules, GS-03 *Personnel Records* (June 2026)
  (lva.virginia.gov/services/rm/schedules/local)
- LVA *Digital Imaging Guidelines* (Sept 2008, URLs updated Aug 2018)
- LVA RM-3 / eRM-3 instructions (v. 04/13/2021) and RM-25 (forms page)

Series-level retention periods in GS-03 were not reviewed and must be applied by the City's
records officer.
