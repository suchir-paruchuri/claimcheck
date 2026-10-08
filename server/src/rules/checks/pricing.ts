import type { BillForAudit, FeeScheduleRate, Finding, LineItem } from '../../domain/types';
import { findingFactory, money, round2 } from '../util';

/** Place-of-service codes priced at the PFS facility rate. */
export const FACILITY_POS = new Set(['19', '21', '22', '23', '24', '26', '31', '34', '41', '42', '51', '52', '53', '56', '61']);

export interface Benchmark {
  perUnit: number;
  source: string;
  version: string;
}

export type BenchmarkResult = { kind: 'priced'; benchmark: Benchmark } | { kind: 'packaged' } | { kind: 'none' };

function pick(rates: FeeScheduleRate[], item: LineItem, schedule: FeeScheduleRate['schedule']) {
  const candidates = rates.filter((r) => r.schedule === schedule && r.code === item.code);
  // Prefer an exact modifier match (e.g. TC or 26), then the code's base row.
  return candidates.find((r) => r.modifier && item.modifiers.includes(r.modifier)) ?? candidates.find((r) => !r.modifier);
}

/** Finds the Medicare benchmark for one line, using the schedule that matches the bill type. */
export function benchmarkFor(item: LineItem, billType: BillForAudit['billType'], rates: FeeScheduleRate[]): BenchmarkResult {
  const lab = pick(rates, item, 'CLFS');
  if (billType === 'physician') {
    const pfs = pick(rates, item, 'PFS');
    if (pfs) {
      const facility = item.placeOfService !== undefined && FACILITY_POS.has(item.placeOfService);
      const perUnit = facility ? pfs.facilityRate : pfs.nonFacilityRate;
      if (perUnit && perUnit > 0) {
        return { kind: 'priced', benchmark: { perUnit, source: `PFS, ${facility ? 'facility' : 'non-facility'}`, version: pfs.version } };
      }
    }
  } else if (billType === 'outpatient') {
    const opps = pick(rates, item, 'OPPS');
    if (opps?.packaged) return { kind: 'packaged' };
    if (opps?.rate && opps.rate > 0) return { kind: 'priced', benchmark: { perUnit: opps.rate, source: 'OPPS', version: opps.version } };
  }
  if (lab?.rate && lab.rate > 0) return { kind: 'priced', benchmark: { perUnit: lab.rate, source: 'CLFS', version: lab.version } };
  return { kind: 'none' };
}

export interface PricedLine {
  lineItemId: string;
  benchmark: number;
  ratio: number;
  source: string;
}

/**
 * Flags charges above `multiplier` times the Medicare benchmark as benchmark outliers.
 * This is a configurable heuristic, so findings are pricing concerns, not billing errors.
 * Returns the ratio for every priced line too, so the UI can show the full picture.
 */
export function checkPricing(bill: BillForAudit, rates: FeeScheduleRate[], multiplier: number) {
  const make = findingFactory('pricing');
  const findings: Finding[] = [];
  const priced: PricedLine[] = [];

  for (const item of bill.lineItems) {
    const result = benchmarkFor(item, bill.billType, rates);
    if (result.kind !== 'priced') continue;
    const benchmark = round2(result.benchmark.perUnit * item.units);
    const ratio = round2(item.charge / benchmark);
    priced.push({ lineItemId: item.id, benchmark, ratio, source: result.benchmark.source });
    if (ratio <= multiplier) continue;

    findings.push(
      make({
        category: 'pricing_concern',
        lineItemIds: [item.id],
        amount: item.charge - benchmark,
        message: `Code ${item.code} is billed at ${money(item.charge)}, ${ratio.toFixed(2)}x the Medicare benchmark of ${money(benchmark)} (threshold ${multiplier.toFixed(2)}x).`,
        evidence: {
          code: item.code,
          billedCharge: item.charge,
          medicareBenchmark: benchmark,
          ratio,
          threshold: multiplier,
          source: result.benchmark.source,
          dataVersion: result.benchmark.version,
          result: 'benchmark outlier',
        },
      }),
    );
  }
  return { findings, priced };
}
