# ClaimCheck

Medical bills often contain errors, such as a charge listed twice, two services billed separately when one already includes the other, or a balance higher than what the patient's insurance says they owe. They're hard to catch because itemized bills are dense pages of billing codes. ClaimCheck reads an uploaded bill, checks every line against Medicare's official coding rules and payment rates (over 3 million rules and 19,000 rates), compares the bill with the patient's insurance statements, and explains each problem it finds with the rule or number behind it. It then drafts a dispute letter built only from those verified findings, so a patient can go from a confusing bill to a specific, well-supported dispute in a few minutes.

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
5. **Insurance comparison (optional).** The patient can add the Explanation of Benefits (EOB) their insurer sent. Gemini extracts its lines, which are checked against the PDF's text the same way. A matching step pairs bill lines with EOB lines by date, then code, then billed amount, and also finds EOB lines that group several bill lines (for example, one "Laboratory services" line covering three lab tests) by searching for subsets of same-day charges that add up to the EOB amount. It then flags a balance higher than the patient can owe, charges no statement covers (possibly never submitted to insurance), and charges billed to the patient at a different price than the insurer was billed.
6. **Letter (worker).** Gemini returns one explanation per finding as schema-constrained JSON. Code validates it with Zod (every finding covered, no unknown findings, every dollar amount matches the audit) and retries with the errors as feedback before building the letter from a template.

**Model fallback.** Every Gemini call goes through a chain of Flash models set in `GEMINI_MODELS`, best first. A model that's overloaded (503), out of quota (429), or times out is skipped for a few minutes (10 for quota) and the request moves to the next one; a model the key can't use (404) is skipped for an hour; a bad request or invalid key (other 4xx) stops immediately, since every model would fail the same way. If every model is busy, the job queue retries the whole chain after 10 and 40 seconds. The bill records which model read it and which drafted the letter. `npm run gemini:models` lists the model IDs your key can use.

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

You need an S3 bucket and a Gemini API key either way. Copy `server/.env.example` to `server/.env` and fill it in.

### With Docker (recommended)

Requires Docker Desktop. One command starts MongoDB, the API, and the job worker:

```bash
docker compose up --build    # API on http://localhost:4000
```

The API and worker are the same image started with different commands. MongoDB data lives in a named volume, so imports and bills survive restarts. To load the CMS data, put the files under `data/` (layout below) and run the imports once, using the compiled scripts inside the container:

```bash
docker compose run --rm api node dist/import/importFeeSchedules.js \
  --pfs /data/PPRRVU2026_Oct_nonQPP.csv --opps /data/OPPS_AddendumB_2026_Jul.csv --clfs /data/PUF_CLFS_CY2026_Q4V1.csv

docker compose run --rm api node dist/import/importCodingRules.js \
  --ncci-practitioner '/data/ncci/ccipra-v323r0-f*.txt' --ncci-hospital '/data/ncci/ccioph-v323r0-f*.txt' \
  --mue-practitioner /data/ncci/MCR_MUE_PractitionerServices_Eff_10-01-2026.csv \
  --mue-hospital /data/ncci/MCR_MUE_OutpatientHospitalServices_Eff_10-01-2026.csv
```

```
data/
  PPRRVU2026_Oct_nonQPP.csv
  OPPS_AddendumB_2026_Jul.csv
  PUF_CLFS_CY2026_Q4V1.csv
  ncci/
    ccipra-v323r0-f1.txt ... f4.txt
    ccioph-v323r0-f1.txt ... f4.txt
    MCR_MUE_PractitionerServices_Eff_10-01-2026.csv
    MCR_MUE_OutpatientHospitalServices_Eff_10-01-2026.csv
```

### Running the tests

```bash
cd server
npm install
npm run test:unit                                          # rules engine, verification, letters, parsers: no database
MONGODB_TEST_URI=mongodb://localhost:27017 npm test        # everything, including API tests against the Docker MongoDB
```

The API tests cover sign-up and sign-in (bcrypt hashing, identical errors for wrong passwords and unknown emails, rate limiting), session checks (missing, expired, forged, and wrongly signed JWTs), and bill ownership: every route returns "not found" for another user's bill, and nothing they try changes it. Each test run uses its own `claimcheck_test_*` database and never touches your real data. Without `MONGODB_TEST_URI`, the tests start a temporary in-memory MongoDB instead.

### Without Docker

Install MongoDB 7 and Node 22, then:

```bash
cd server
npm install
npm test
npm run dev            # API on :4000
npm run dev:worker     # job worker, in a second terminal
```

The `npm run import:*` commands in the next section load the CMS data.

### Frontend

```bash
cd client
cp .env.example .env    # VITE_API_URL points at the API
npm install
npm run dev             # http://localhost:5173
VITE_DEMO=1 npm run dev # no backend: a sample bill whose findings come from the real rules engine and 2026 CMS data
```

The demo build is deployed on Vercel (`client/vercel.json`, project root `client`, environment variable `VITE_DEMO=1`). It runs entirely in the browser on a sample bill and insurance statement, both viewable as PDFs, so it needs no API, database, or Gemini key.

The React app walks a patient through upload, a review screen that marks lines that couldn't be confirmed against the bill, the annotated results (errors struck through in red, pricing concerns highlighted, with the math behind each one), and an editable dispute letter.

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
| PATCH | `/account/name` | change display name |
| PATCH | `/account/email` | change email (requires current password) |
| PATCH | `/account/password` | change password (requires current password; signs out other sessions) |
| DELETE | `/account` | delete the account, its bills, and uploaded files (requires current password) |
| GET | `/bills` | dashboard list |
| POST | `/bills` | create bill, returns presigned upload URL |
| POST | `/bills/:id/uploaded` | queue extraction |
| GET | `/bills/:id` | status, line items, findings, letter (polled) |
| PUT | `/bills/:id/review` | confirm items and admission answer, queue audit |
| POST | `/bills/:id/letter` | queue letter drafting |
| PUT | `/bills/:id/letter` | save patient edits |
| DELETE | `/bills/:id` | delete bill and its files |
| POST | `/bills/:id/eobs` | add an insurance statement, returns presigned upload URL |
| POST | `/bills/:id/eobs/:eobId/uploaded` | queue statement extraction |
| DELETE | `/bills/:id/eobs/:eobId` | remove a statement and re-run the comparison |
