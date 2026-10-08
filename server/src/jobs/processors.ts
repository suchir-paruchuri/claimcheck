import type { Job } from 'agenda';
import { config } from '../config';
import type { BillForAudit, Finding } from '../domain/types';
import { totalsReconcile, verifyItem } from '../extraction/verify';
import { buildLetter, validateLetterSections } from '../letters/letter';
import { ExtractionSchema, type LlmProvider } from '../llm/provider';
import { Bill } from '../models/Bill';
import { User } from '../models/User';
import { classifyBill } from '../rules/classify';
import { codesNeeded, runAudit } from '../rules/engine';
import { readPdfText } from '../services/pdfText';
import { loadCmsDescriptions, loadReferenceData } from '../services/referenceData';
import { downloadFile } from '../services/storage';
import { agenda, JOBS, type BillJobData, type JobName } from './queue';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10_000, 40_000];
const LETTER_VALIDATION_ATTEMPTS = 3;

class PermanentError extends Error {}

/**
 * Wraps a processor with retries: failures are rescheduled with growing delays, and after
 * the last attempt the bill is marked failed with a readable error. Each processor
 * overwrites its own step's results, so a retry never duplicates data.
 */
function withRetries(name: JobName, handler: (billId: string) => Promise<void>) {
  return async (job: Job<BillJobData>) => {
    const { billId, attempt = 1 } = job.attrs.data;
    try {
      await handler(billId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${name}] bill ${billId} attempt ${attempt} failed: ${message}`);
      if (!(err instanceof PermanentError) && attempt < MAX_ATTEMPTS) {
        await agenda.schedule<BillJobData>(new Date(Date.now() + RETRY_DELAYS_MS[attempt - 1]), name, { billId, attempt: attempt + 1 });
        return;
      }
      if (name === JOBS.letter) await Bill.updateOne({ _id: billId }, { 'letter.status': 'failed', error: message });
      else await Bill.updateOne({ _id: billId }, { status: 'failed', error: `We couldn't process this bill: ${message}` });
    }
  };
}

export function toBillForAudit(bill: InstanceType<typeof Bill>): BillForAudit {
  return {
    billType: bill.billType ?? 'uncertain',
    statedTotal: bill.statedTotal ?? undefined,
    admissionDate: bill.admissionDate ?? undefined,
    dischargeDate: bill.dischargeDate ?? undefined,
    lineItems: bill.lineItems.map((li) => ({
      id: li.id,
      code: li.code,
      description: li.description,
      revenueCode: li.revenueCode ?? undefined,
      modifiers: li.modifiers,
      units: li.units,
      unitPrice: li.unitPrice ?? undefined,
      charge: li.charge,
      dateOfService: li.dateOfService,
      placeOfService: li.placeOfService ?? undefined,
      notReceived: li.notReceived,
    })),
  };
}

export async function extractBill(billId: string, llm: LlmProvider) {
  const bill = await Bill.findById(billId);
  if (!bill) throw new PermanentError('Bill not found');
  const started = Date.now();
  bill.status = 'extracting';
  bill.error = undefined;
  await bill.save();

  const pdf = await downloadFile(bill.fileKey);
  const pageTexts = await readPdfText(pdf);
  const parsed = ExtractionSchema.safeParse(await llm.extractBill(pdf));
  if (!parsed.success) throw new Error('The extraction response did not match the expected format');
  const extraction = parsed.data;
  if (extraction.lineItems.length === 0) throw new PermanentError('No line items were found. Is this an itemized bill?');

  const descriptions = await loadCmsDescriptions([...new Set(extraction.lineItems.map((i) => i.code))]);
  bill.set({
    providerName: extraction.providerName,
    accountNumber: extraction.accountNumber,
    typeOfBill: extraction.typeOfBill,
    admissionDate: extraction.admissionDate,
    dischargeDate: extraction.dischargeDate,
    statedTotal: extraction.statedTotal,
    totalsReconcile: totalsReconcile(extraction.lineItems.map((i) => i.charge), extraction.statedTotal),
    lineItems: extraction.lineItems.map((item, i) => {
      const v = verifyItem(item, pageTexts, descriptions.get(item.code));
      const { sourceText: _ignored, ...fields } = item;
      return { ...fields, id: `li-${i + 1}`, extractionStatus: v.extractionStatus, verification: v.verification, reviewReasons: v.reasons, source: v.source };
    }),
  });
  const suggestion = classifyBill({
    revenueCodes: extraction.lineItems.flatMap((i) => (i.revenueCode ? [i.revenueCode] : [])),
    typeOfBill: extraction.typeOfBill,
    admissionDate: extraction.admissionDate,
    dischargeDate: extraction.dischargeDate,
  });
  bill.suggestedBillType = suggestion.billType;
  bill.classificationReasons = suggestion.reasons;
  bill.status = 'awaiting_review';
  bill.set('timings.extractionMs', Date.now() - started);
  await bill.save();
}

export async function analyzeBill(billId: string) {
  const bill = await Bill.findById(billId);
  if (!bill) throw new PermanentError('Bill not found');
  const started = Date.now();
  bill.status = 'analyzing';
  await bill.save();

  const audit = toBillForAudit(bill);
  const ref = await loadReferenceData(codesNeeded(audit));
  const result = runAudit(audit, ref, { benchmarkMultiplier: config.benchmarkMultiplier });

  bill.set({
    findings: result.findings,
    checksRun: result.checksRun,
    checksSkipped: result.checksSkipped,
    totals: result.totals,
    benchmarkMultiplier: config.benchmarkMultiplier,
    status: 'complete',
    'timings.analysisMs': Date.now() - started,
  });
  await bill.save();
}

export async function draftLetter(billId: string, llm: LlmProvider) {
  const bill = await Bill.findById(billId);
  if (!bill) throw new PermanentError('Bill not found');
  const started = Date.now();
  // Only findings from checks that ran; informational notes never go in the letter.
  const findings = (bill.findings as unknown as Finding[]).filter((f) => f.category !== 'info');
  if (findings.length === 0) throw new PermanentError('There are no findings to dispute');

  let feedback: string[] = [];
  for (let i = 0; i < LETTER_VALIDATION_ATTEMPTS; i++) {
    const validation = validateLetterSections(await llm.draftLetterSections(findings, feedback), findings);
    if (validation.ok) {
      const user = await User.findById(bill.userId).select('name');
      const text = buildLetter(
        {
          patientName: user?.name ?? '',
          providerName: bill.providerName ?? undefined,
          accountNumber: bill.accountNumber ?? undefined,
          date: new Date().toLocaleDateString('en-US', { dateStyle: 'long' }),
        },
        findings,
        validation.sections!,
      );
      bill.set({ letter: { text, generatedAt: new Date(), status: 'ready' }, 'timings.letterMs': Date.now() - started });
      await bill.save();
      return;
    }
    feedback = validation.errors;
  }
  throw new Error(`The drafted letter failed validation: ${feedback.join(' ')}`);
}

export function registerProcessors(llm: LlmProvider) {
  // Concurrency caps on the Gemini-backed jobs keep requests within the API's rate limits.
  agenda.define<BillJobData>(JOBS.extract, { concurrency: 2 }, withRetries(JOBS.extract, (id) => extractBill(id, llm)));
  agenda.define<BillJobData>(JOBS.analyze, { concurrency: 5 }, withRetries(JOBS.analyze, analyzeBill));
  agenda.define<BillJobData>(JOBS.letter, { concurrency: 1 }, withRetries(JOBS.letter, (id) => draftLetter(id, llm)));
}
