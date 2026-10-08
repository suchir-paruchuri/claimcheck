import type { BillForAudit, Finding } from '../../domain/types';
import { findingFactory, money, round2 } from '../util';

const TOLERANCE = 0.01;

/** Line items that don't add up, or units x unit price that doesn't match the charge. */
export function checkMath(bill: BillForAudit): Finding[] {
  const make = findingFactory('math');
  const findings: Finding[] = [];

  for (const item of bill.lineItems) {
    if (item.unitPrice === undefined) continue;
    const expected = round2(item.unitPrice * item.units);
    const diff = round2(item.charge - expected);
    if (Math.abs(diff) > TOLERANCE) {
      findings.push(
        make({
          category: 'billing_error',
          lineItemIds: [item.id],
          amount: Math.max(diff, 0),
          message: `Code ${item.code}: ${item.units} unit(s) at ${money(item.unitPrice)} should total ${money(expected)}, but the line is billed at ${money(item.charge)}.`,
          evidence: { code: item.code, units: item.units, unitPrice: item.unitPrice, expected, billed: item.charge },
        }),
      );
    }
  }

  if (bill.statedTotal !== undefined) {
    const sum = round2(bill.lineItems.reduce((s, i) => s + i.charge, 0));
    const diff = round2(bill.statedTotal - sum);
    if (Math.abs(diff) > TOLERANCE) {
      findings.push(
        make({
          category: 'billing_error',
          lineItemIds: [],
          amount: Math.max(diff, 0),
          message: `The bill's stated total is ${money(bill.statedTotal)}, but its line items add up to ${money(sum)}.`,
          evidence: { statedTotal: bill.statedTotal, lineItemSum: sum },
        }),
      );
    }
  }
  return findings;
}
