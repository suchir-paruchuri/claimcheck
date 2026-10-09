import type { AuditResult, BillForAudit, CheckId, Finding, NcciVersion, ReferenceData, SkippedCheck } from '../domain/types';
import { checkDuplicates } from './checks/duplicates';
import { checkMath } from './checks/math';
import { checkNotReceived } from './checks/notReceived';
import { checkOutsideStay } from './checks/outsideStay';
import { checkPricing } from './checks/pricing';
import { checkUnbundling } from './checks/unbundling';
import { checkUnitLimits } from './checks/unitLimits';
import { round2 } from './util';

export const ALL_CHECKS: CheckId[] = ['duplicates', 'math', 'unbundling', 'unit_limits', 'pricing', 'not_received', 'outside_stay'];

const BUNDLED_STAY_REASON =
  'Hospital stays are usually paid as one bundled amount, not item by item, so this line-by-line check would be misleading.';

/** Which checks are valid for each bill type, and why the others are skipped. */
export function planChecks(bill: BillForAudit): { run: CheckId[]; skipped: SkippedCheck[] } {
  const skipped: SkippedCheck[] = [];
  const run: CheckId[] = ['duplicates', 'math'];
  const hospitalStay = bill.billType === 'inpatient' || bill.billType === 'uncertain';

  for (const id of ['unbundling', 'unit_limits', 'pricing'] as const) {
    if (hospitalStay) skipped.push({ checkId: id, reason: BUNDLED_STAY_REASON });
    else run.push(id);
  }
  run.push('not_received');

  if (!hospitalStay) {
    skipped.push({ checkId: 'outside_stay', reason: 'Only applies to hospital stays with admission and discharge dates.' });
  } else if (!bill.admissionDate || !bill.dischargeDate) {
    skipped.push({ checkId: 'outside_stay', reason: 'The bill does not list both an admission and a discharge date.' });
  } else {
    run.push('outside_stay');
  }
  return { run, skipped };
}

export function ncciVersionFor(bill: BillForAudit): NcciVersion {
  return bill.billType === 'physician' ? 'practitioner' : 'hospital';
}

/**
 * Runs every check valid for the bill's type. Pure: all reference data is passed in,
 * already fetched in batch, so the engine does no I/O.
 */
export function runAudit(bill: BillForAudit, ref: ReferenceData, opts: { benchmarkMultiplier: number }): AuditResult {
  const { run, skipped } = planChecks(bill);
  const version = ncciVersionFor(bill);
  const findings: Finding[] = [];

  for (const id of run) {
    switch (id) {
      case 'duplicates': findings.push(...checkDuplicates(bill)); break;
      case 'math': findings.push(...checkMath(bill)); break;
      case 'unbundling': findings.push(...checkUnbundling(bill, ref.ncciEdits, version)); break;
      case 'unit_limits': findings.push(...checkUnitLimits(bill, ref.mueLimits, version)); break;
      case 'pricing': findings.push(...checkPricing(bill, ref.rates, opts.benchmarkMultiplier).findings); break;
      case 'not_received': findings.push(...checkNotReceived(bill)); break;
      case 'outside_stay': findings.push(...checkOutsideStay(bill)); break;
    }
  }

  // A line whose whole charge is already disputed (a repeated duplicate, a code billed separately
  // that should be bundled, a service not received, a charge outside the stay) shouldn't also
  // count as a pricing concern, or totals double-count.
  const fullyDisputed = new Set<string>();
  for (const f of findings) {
    if (f.checkId === 'duplicates' || f.checkId === 'unbundling') f.lineItemIds.slice(1).forEach((id) => fullyDisputed.add(id));
    if ((f.checkId === 'not_received' || f.checkId === 'outside_stay') && f.category === 'billing_error') f.lineItemIds.forEach((id) => fullyDisputed.add(id));
  }
  const kept = findings.filter((f) => f.checkId !== 'pricing' || !fullyDisputed.has(f.lineItemIds[0]));
  findings.length = 0;
  findings.push(...kept);

  const sum = (cat: Finding['category']) => round2(findings.filter((f) => f.category === cat).reduce((s, f) => s + f.amount, 0));
  return {
    findings,
    checksRun: run,
    checksSkipped: skipped,
    totals: {
      billed: round2(bill.lineItems.reduce((s, i) => s + i.charge, 0)),
      billingErrors: sum('billing_error'),
      pricingConcerns: sum('pricing_concern'),
    },
  };
}

/** Codes the engine will need reference data for, so callers can batch-fetch it in one query per collection. */
export function codesNeeded(bill: BillForAudit): string[] {
  return [...new Set(bill.lineItems.map((i) => i.code))];
}
