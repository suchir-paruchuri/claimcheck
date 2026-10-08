import type { BillForAudit, LineItem } from '../src/domain/types';

let n = 0;
export function item(overrides: Partial<LineItem> = {}): LineItem {
  return {
    id: `li-${++n}`,
    code: '99213',
    description: 'Office visit, established patient',
    modifiers: [],
    units: 1,
    charge: 100,
    dateOfService: '2026-08-01',
    ...overrides,
  };
}

export function bill(lineItems: LineItem[], overrides: Partial<BillForAudit> = {}): BillForAudit {
  return { billType: 'physician', lineItems, ...overrides };
}
