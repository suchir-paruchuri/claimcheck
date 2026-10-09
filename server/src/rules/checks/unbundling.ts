import type { BillForAudit, Finding, LineItem, NcciEdit, NcciVersion } from '../../domain/types';
import { findingFactory, money } from '../util';

/**
 * Modifiers CMS recognizes for bypassing an NCCI edit whose modifier indicator is 1.
 * (Anatomic, global-surgery, and distinct-service modifiers.)
 */
export const NCCI_BYPASS_MODIFIERS = new Set([
  'E1', 'E2', 'E3', 'E4', 'FA', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9',
  'LC', 'LD', 'LM', 'LT', 'RC', 'RI', 'RT', 'TA', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9',
  '24', '25', '27', '57', '58', '59', '78', '79', '91', 'XE', 'XS', 'XP', 'XU',
]);

function editApplies(edit: NcciEdit, date: string): boolean {
  if (edit.effectiveDate > date) return false;
  if (edit.deletionDate && edit.deletionDate <= date) return false;
  return true;
}

function hasBypassModifier(item: LineItem) {
  return item.modifiers.some((m) => NCCI_BYPASS_MODIFIERS.has(m.toUpperCase()));
}

/** Code pairs billed on the same date that NCCI says shouldn't be billed together. */
export function checkUnbundling(bill: BillForAudit, edits: NcciEdit[], version: NcciVersion): Finding[] {
  const make = findingFactory('unbundling');
  const index = new Map<string, NcciEdit[]>();
  for (const e of edits) {
    if (e.version !== version) continue;
    const key = `${e.column1}|${e.column2}`;
    index.set(key, [...(index.get(key) ?? []), e]);
  }

  const findings: Finding[] = [];
  const items = bill.lineItems;
  for (const col1 of items) {
    for (const col2 of items) {
      if (col1 === col2 || col1.dateOfService !== col2.dateOfService) continue;
      const edit = index.get(`${col1.code}|${col2.code}`)?.find((e) => editApplies(e, col1.dateOfService));
      if (!edit) continue;
      if (edit.modifierIndicator === 1 && (hasBypassModifier(col2) || hasBypassModifier(col1))) continue;

      findings.push(
        make({
          category: 'billing_error',
          lineItemIds: [col1.id, col2.id],
          amount: col2.charge,
          message:
            `Code ${col2.code} is generally included in code ${col1.code} when both are billed on ${col1.dateOfService}` +
            (edit.modifierIndicator === 0
              ? ', and CMS does not allow them to be billed separately.'
              : ', and no modifier indicating a separate, distinct service was reported.') +
            ` The separately billed charge is ${money(col2.charge)}.`,
          evidence: {
            rule: 'NCCI procedure-to-procedure edit',
            column1: col1.code,
            column2: col2.code,
            dateOfService: col1.dateOfService,
            modifierIndicator: edit.modifierIndicator,
            tableVersion: version,
            dataVersion: edit.dataVersion,
          },
        }),
      );
    }
  }
  return findings;
}
