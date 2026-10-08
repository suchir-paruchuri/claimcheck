import type { BillForAudit, Finding } from '../../domain/types';
import { findingFactory, money } from '../util';

/** Same code, date, units, and modifiers billed more than once. */
export function checkDuplicates(bill: BillForAudit): Finding[] {
  const make = findingFactory('duplicates');
  const groups = new Map<string, typeof bill.lineItems>();
  for (const item of bill.lineItems) {
    const key = [item.code, item.dateOfService, item.units, [...item.modifiers].sort().join('+')].join('|');
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const findings: Finding[] = [];
  for (const items of groups.values()) {
    if (items.length < 2) continue;
    const [first, ...extras] = items;
    const amount = extras.reduce((sum, i) => sum + i.charge, 0);
    findings.push(
      make({
        category: 'billing_error',
        lineItemIds: items.map((i) => i.id),
        amount,
        message: `Code ${first.code} is billed ${items.length} times on ${first.dateOfService} with identical units and modifiers. The ${extras.length} repeated charge(s) total ${money(amount)}.`,
        evidence: { code: first.code, dateOfService: first.dateOfService, occurrences: items.length },
      }),
    );
  }
  return findings;
}
