# ClaimCheck

Medical bill auditing and dispute assistant. A patient uploads an itemized bill; ClaimCheck extracts the line items, verifies them against the PDF itself and Medicare reference data, runs the audit checks that are valid for the bill type, and drafts a dispute letter built only from the findings.

> Not legal or medical advice. Pricing concerns compare charges with Medicare rates, which are not what a private insurer agreed to pay.

## How it works

1. **Upload.** The browser uploads the PDF straight to S3 with a presigned URL. The Express API queues an extraction job.
2. **Extraction (worker).** Gemini turns the bill into structured line items and returns the exact text it read for each one. Code then verifies every item independently:
   - `foundInDocument`: the code appears in the PDF's own text layer (pdf.js)
   - `cmsMatch`: the code exists in Medicare's fee schedules
   - `descriptionMatch`: the bill's description resembles CMS's descriptor

   The model never reports confidence scores or page coordinates.
3. **Review.** The patient corrects flagged items, marks services not received, and answers whether they were formally admitted. A classifier combines that answer with signals on the bill (room-and-board and observation revenue codes, type-of-bill code) to pick the bill type.
4. **Audit (worker).** A pure TypeScript rules engine runs the checks valid for the bill type, using reference data fetched in one indexed query per collection.
5. **Letter (worker).** Gemini returns one explanation per finding as schema-constrained JSON. Code validates it with Zod (every finding covered, no unknown findings, every dollar amount matches the audit) and retries with the errors as feedback before building the letter from a template.

| Check | Doctor | Hospital outpatient | Inpatient / uncertain |
|---|---|---|---|
| Duplicates | ✓ | ✓ | ✓ |
| Math errors | ✓ | ✓ | ✓ |
| Unbundling (NCCI) | practitioner table | hospital table | skipped |
| Unit limits (MUE) | practitioner table | hospital table | skipped |
| Pricing vs. Medicare | PFS facility/non-facility | OPPS, lab fee schedule | skipped |
| Not received | ✓ | ✓ | ✓ |
| Charges outside the stay | | | ✓ |

**Pricing threshold.** Charges above `BENCHMARK_MULTIPLIER` (default 3x) times the Medicare benchmark are flagged as *benchmark outliers*, a pricing concern rather than a billing error. Hospital list prices and commercial negotiated rates commonly run well above Medicare, so a low threshold would flag nearly everything. Every flag shows the benchmark, charge, ratio, and threshold.

## Running locally

Requirements: Node 22, MongoDB 7, an S3 bucket, a Gemini API key.

```bash
cd server
cp .env.example .env   # fill in values
npm install
npm test
npm run dev            # API on :4000
npm run dev:worker     # job worker
```

### Loading Medicare data

Download from CMS (accept the AMA license; don't commit these files):

- [Physician Fee Schedule](https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files) — the `PPRRVU..._nonQPP.csv` file
- [OPPS Addendum B](https://www.cms.gov/Medicare/Medicare-Fee-For-Service-Payment/HospitalOutpatientPPS/Addendum-A-and-Addendum-B-Updates) — the CSV
- [Clinical Laboratory Fee Schedule](https://www.cms.gov/medicare/payment/fee-schedules/clinical-laboratory-fee-schedule-clfs/files)

```bash
npm run import:fees -- --pfs data/PPRRVU2026_Oct_nonQPP.csv \
  --opps data/OPPS_AddendumB_2026_Jul.csv --clfs data/PUF_CLFS_CY2026_Q4V1.csv [--dry-run]
```

The import streams each file and writes in 1,000-row bulk upserts. With the October 2026 PFS, July 2026 OPPS, and Q4 2026 lab files it loads **19,011 priced rates** (9,526 PFS, 7,360 OPPS, 2,125 lab) plus 2,086 packaged OPPS codes.

Then the coding rules (Q4 2026: the 8 NCCI PTP files from the [PTP edits page](https://www.cms.gov/medicare-medicaid-coordination/national-correct-coding-initiative-ncci/ncci-medicare/medicare-ncci-procedure-procedure-ptp-edits) and the practitioner and outpatient hospital tables from the [MUE page](https://www.cms.gov/medicare-medicaid-coordination/national-correct-coding-initiative-ncci/ncci-medicare/medicare-ncci-medically-unlikely-edits); use the `.txt` and `.csv` files inside the ZIPs):

```bash
npm run import:rules -- \
  --ncci-practitioner 'data/ncci/ccipra-v323r0-f*.txt' --ncci-hospital 'data/ncci/ccioph-v323r0-f*.txt' \
  --mue-practitioner data/ncci/MCR_MUE_PractitionerServices_Eff_10-01-2026.csv \
  --mue-hospital data/ncci/MCR_MUE_OutpatientHospitalServices_Eff_10-01-2026.csv [--since 2024-01-01] [--dry-run]
```

The PTP files are read line by line and inserted in 5,000-row batches. Of 4,506,527 Q4 2026 PTP rows, the import keeps **3,191,316 edits** (1,761,922 practitioner, 1,429,394 hospital): it drops edits CMS marks not applicable (modifier indicator 9) and edits deleted before `--since`. It also loads **30,374 MUE limits**. Each run replaces that table version, so importing a new quarter leaves no stale rules.

### S3 setup

Enable CORS for `PUT` from your frontend origin, and add a lifecycle rule that expires objects under `uploads/` after 30 days.

## API

All `/bills` routes require the session cookie, and every query filters by the signed-in user's ID.

| Method | Route | |
|---|---|---|
| POST | `/auth/signup`, `/auth/login`, `/auth/logout` | bcrypt-hashed passwords, JWT in an httpOnly cookie, rate-limited |
| GET | `/auth/me` | current user |
| GET | `/bills` | dashboard list |
| POST | `/bills` | create bill, returns presigned upload URL |
| POST | `/bills/:id/uploaded` | queue extraction |
| GET | `/bills/:id` | status, line items, findings, letter (polled) |
| PUT | `/bills/:id/review` | confirm items and admission answer, queue audit |
| POST | `/bills/:id/letter` | queue letter drafting |
| PUT | `/bills/:id/letter` | save patient edits |
| DELETE | `/bills/:id` | delete bill and its file |

## Known limitations

- Medicare national rates, no regional adjustment.
- Inpatient bills get a reduced set of checks; classification can be uncertain, and the app says so.
- Source matching needs a text-based PDF (no OCR yet).
- On Gemini's free tier, submitted content may be used by Google, so use synthetic bills only.
- Coding rules cover dates of service from `--since` (default 2024-01-01) onward, and MUE limits are the current quarter's values.
