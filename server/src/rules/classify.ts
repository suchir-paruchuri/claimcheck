import type { AdmissionAnswer, BillType } from '../domain/types';
import { daysBetween } from './util';

export interface ClassificationInput {
  revenueCodes: string[];
  typeOfBill?: string;
  admissionDate?: string;
  dischargeDate?: string;
  answer?: AdmissionAnswer;
}

export interface Classification {
  billType: BillType;
  signal: 'inpatient' | 'outpatient' | 'conflicting' | 'weak' | 'professional';
  reasons: string[];
}

const isRoomAndBoard = (rev: string) => {
  const n = Number(rev);
  return Number.isInteger(n) && n >= 100 && n <= 219;
};
const OBSERVATION_REVENUE_CODE = '0762';
const pad = (rev: string) => rev.padStart(4, '0');

/**
 * Combines signals on the bill with the patient's answer to "Were you formally admitted?".
 * An overnight stay alone is never treated as proof of inpatient status, because patients
 * kept overnight under observation are outpatients.
 */
export function classifyBill(input: ClassificationInput): Classification {
  const reasons: string[] = [];
  const revs = input.revenueCodes.map(pad);
  const tob = input.typeOfBill?.replace(/^0/, '');

  // No revenue codes and no type-of-bill code means a professional (doctor's) claim.
  if (revs.length === 0 && !tob) {
    return { billType: 'physician', signal: 'professional', reasons: ['No hospital revenue codes or type-of-bill code: this is a doctor\'s bill.'] };
  }

  let inpatient = 0;
  let outpatient = 0;
  if (revs.some(isRoomAndBoard)) { inpatient++; reasons.push('Room-and-board charges (revenue codes 0100-0219).'); }
  if (tob?.startsWith('11')) { inpatient++; reasons.push(`Type-of-bill code ${input.typeOfBill} indicates a hospital inpatient claim.`); }
  if (tob?.startsWith('13')) { outpatient++; reasons.push(`Type-of-bill code ${input.typeOfBill} indicates a hospital outpatient claim.`); }
  if (revs.includes(OBSERVATION_REVENUE_CODE)) { outpatient++; reasons.push('Observation room charge (revenue code 0762), which means outpatient status.'); }
  if (input.admissionDate && input.dischargeDate && daysBetween(input.admissionDate, input.dischargeDate) >= 1) {
    reasons.push('The stay spans more than one day (not proof of inpatient status on its own).');
  }

  const signal: Classification['signal'] =
    inpatient && outpatient ? 'conflicting' : inpatient ? 'inpatient' : outpatient ? 'outpatient' : 'weak';
  const answer = input.answer ?? 'unsure';

  let billType: BillType;
  if (signal === 'conflicting') billType = 'uncertain';
  else if (signal === 'inpatient') billType = answer === 'not_admitted' ? 'uncertain' : 'inpatient';
  else if (signal === 'outpatient') billType = answer === 'admitted' ? 'uncertain' : 'outpatient';
  else billType = answer === 'admitted' ? 'inpatient' : answer === 'not_admitted' ? 'outpatient' : 'uncertain';

  if (billType === 'uncertain') {
    reasons.push(
      signal === 'weak'
        ? 'The bill does not clearly show inpatient or outpatient status, and you weren\'t sure whether you were admitted.'
        : 'The bill\'s signals and your answer about being admitted point in different directions.',
    );
  }
  return { billType, signal, reasons };
}
