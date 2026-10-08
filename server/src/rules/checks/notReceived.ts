import type { BillForAudit, Finding } from '../../domain/types';
import { findingFactory, money } from '../util';

/** Services the patient marked during review as never received. */
export function checkNotReceived(bill: BillForAudit): Finding[] {
  const make = findingFactory('not_received');
  return bill.lineItems
    .filter((i) => i.notReceived)
    .map((i) =>
      make({
        category: 'billing_error',
        lineItemIds: [i.id],
        amount: i.charge,
        message: `The patient reports not receiving "${i.description}" (code ${i.code}) on ${i.dateOfService}, billed at ${money(i.charge)}.`,
        evidence: { code: i.code, dateOfService: i.dateOfService, reportedBy: 'patient' },
      }),
    );
}
