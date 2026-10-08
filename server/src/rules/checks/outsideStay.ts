import type { BillForAudit, Finding } from '../../domain/types';
import { daysBetween, findingFactory, money } from '../util';

/** Medicare's payment window: outpatient services up to 3 days before admission can be bundled into the stay. */
export const PREADMISSION_WINDOW_DAYS = 3;

/** Inpatient bills: charges dated after discharge, or more than 3 days before admission. */
export function checkOutsideStay(bill: BillForAudit): Finding[] {
  const make = findingFactory('outside_stay');
  const { admissionDate, dischargeDate } = bill;
  if (!admissionDate || !dischargeDate) return [];

  const findings: Finding[] = [];
  for (const item of bill.lineItems) {
    const date = item.dateOfService;
    if (date > dischargeDate) {
      findings.push(
        make({
          category: 'billing_error',
          lineItemIds: [item.id],
          amount: item.charge,
          message: `Code ${item.code} is dated ${date}, after the discharge date of ${dischargeDate}. Charge: ${money(item.charge)}.`,
          evidence: { code: item.code, dateOfService: date, dischargeDate },
        }),
      );
    } else if (date < admissionDate) {
      const daysBefore = daysBetween(date, admissionDate);
      if (daysBefore > PREADMISSION_WINDOW_DAYS) {
        findings.push(
          make({
            category: 'billing_error',
            lineItemIds: [item.id],
            amount: item.charge,
            message: `Code ${item.code} is dated ${date}, ${daysBefore} days before admission on ${admissionDate}. Charge: ${money(item.charge)}.`,
            evidence: { code: item.code, dateOfService: date, admissionDate, daysBeforeAdmission: daysBefore },
          }),
        );
      } else {
        findings.push(
          make({
            category: 'info',
            lineItemIds: [item.id],
            amount: 0,
            message: `Code ${item.code} is dated ${daysBefore} day(s) before admission. Services in the ${PREADMISSION_WINDOW_DAYS}-day preadmission window can legitimately be billed as part of the stay.`,
            evidence: { code: item.code, dateOfService: date, admissionDate, daysBeforeAdmission: daysBefore },
          }),
        );
      }
    }
  }
  return findings;
}
