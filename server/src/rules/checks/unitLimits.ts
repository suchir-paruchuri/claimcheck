import type { BillForAudit, Finding, MueLimit, NcciVersion } from '../../domain/types';
import { findingFactory } from '../util';

/**
 * Units above the Medically Unlikely Edit for a code. MAI 1 limits apply to each claim line;
 * MAI 2 and 3 limits apply to all units of the code on the same date of service.
 * A code with no published MUE is never flagged ("no published limit", not "no limit").
 */
export function checkUnitLimits(bill: BillForAudit, limits: MueLimit[], version: NcciVersion): Finding[] {
  const make = findingFactory('unit_limits');
  const byCode = new Map(limits.filter((l) => l.version === version).map((l) => [l.code, l]));
  const findings: Finding[] = [];

  const perDate = new Map<string, typeof bill.lineItems>();
  for (const item of bill.lineItems) {
    const mue = byCode.get(item.code);
    if (!mue) continue;
    if (mue.mai === 1) {
      if (item.units > mue.limit) {
        const excess = item.units - mue.limit;
        findings.push(
          make({
            category: 'billing_error',
            lineItemIds: [item.id],
            amount: (item.charge / item.units) * excess,
            message: `Code ${item.code} is billed with ${item.units} units on one line; the CMS limit is ${mue.limit} per line.`,
            evidence: { rule: 'Medically Unlikely Edit', code: item.code, limit: mue.limit, billedUnits: item.units, appliesTo: 'claim line', dataVersion: mue.dataVersion },
          }),
        );
      }
    } else {
      const key = `${item.code}|${item.dateOfService}`;
      perDate.set(key, [...(perDate.get(key) ?? []), item]);
    }
  }

  for (const items of perDate.values()) {
    const mue = byCode.get(items[0].code)!;
    const units = items.reduce((s, i) => s + i.units, 0);
    if (units <= mue.limit) continue;
    const charge = items.reduce((s, i) => s + i.charge, 0);
    findings.push(
      make({
        category: 'billing_error',
        lineItemIds: items.map((i) => i.id),
        amount: (charge / units) * (units - mue.limit),
        message: `Code ${items[0].code} is billed for ${units} units on ${items[0].dateOfService}; the CMS limit is ${mue.limit} per day.`,
        evidence: { rule: 'Medically Unlikely Edit', code: items[0].code, limit: mue.limit, billedUnits: units, appliesTo: 'date of service', dataVersion: mue.dataVersion },
      }),
    );
  }
  return findings;
}
