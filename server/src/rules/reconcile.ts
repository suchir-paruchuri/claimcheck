// Reconciles an itemized bill against the patient's insurance statements (Explanations of
// Benefits). An EOB lists, for each service the insurer processed, the amount billed, what the
// plan paid, and what the patient owes. The bill should never ask for more than that.
import type { Finding, LineItem } from '../domain/types';
import { descriptionSimilarity } from '../extraction/verify';
import { findingFactory, money, round2 } from './util';

export interface EobLine {
  id: string; // unique across all EOBs on the bill, e.g. "eob1-3"
  eobId: string;
  dateOfService: string;
  code?: string;
  description: string;
  billed: number; // what the provider billed the insurer
  allowed?: number;
  planPaid?: number;
  patientResponsibility: number; // deductible + copay + coinsurance + anything not covered
}

export interface Eob {
  id: string;
  payer?: string;
  claimNumber?: string;
  lines: EobLine[];
}

export interface Match {
  eobLineId: string;
  billLineIds: string[]; // more than one when the EOB groups several bill lines into one
  how: 'code' | 'amount' | 'description' | 'grouped';
}

export interface Reconciliation {
  matches: Match[];
  unmatchedBillLineIds: string[];
  unmatchedEobLineIds: string[];
  /** What the patient owes for the matched services, according to the EOBs */
  patientResponsibility: number;
  /** The most the bill could legitimately ask for: matched responsibility plus charges no EOB covers */
  maxExpectedDue: number;
  findings: Finding[];
}

const TOLERANCE = 0.01;
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
const MAX_GROUP = 4;

/** How strongly a bill line and an EOB line look like the same service (0 = not a match). */
function score(bill: LineItem, eob: EobLine): { score: number; how: Match['how'] } {
  if (bill.dateOfService !== eob.dateOfService) return { score: 0, how: 'code' };
  const codeMatch = !!eob.code && eob.code.toUpperCase() === bill.code.toUpperCase();
  const amountMatch = sameAmount(bill.charge, eob.billed);
  const descMatch = descriptionSimilarity(bill.description, eob.description) >= 0.34;
  // A code match alone, or an amount match alone, is enough. A description match only breaks ties.
  const s = (codeMatch ? 3 : 0) + (amountMatch ? 2 : 0) + (descMatch ? 1 : 0);
  if (!codeMatch && !amountMatch) return { score: 0, how: 'description' };
  return { score: s, how: codeMatch ? 'code' : amountMatch ? 'amount' : 'description' };
}

/** Finds up to MAX_GROUP bill lines from one date whose charges add up to `target`. */
function findGroup(candidates: LineItem[], target: number): LineItem[] | undefined {
  const sorted = [...candidates].sort((a, b) => b.charge - a.charge);
  const pick: LineItem[] = [];
  const search = (start: number, remaining: number): boolean => {
    if (pick.length >= 2 && Math.abs(remaining) <= TOLERANCE) return true;
    if (pick.length === MAX_GROUP || remaining < -TOLERANCE) return false;
    for (let i = start; i < sorted.length; i++) {
      pick.push(sorted[i]);
      if (search(i + 1, round2(remaining - sorted[i].charge))) return true;
      pick.pop();
    }
    return false;
  };
  return search(0, target) ? [...pick] : undefined;
}

export function matchLines(billLines: LineItem[], eobLines: EobLine[]) {
  const matches: Match[] = [];
  const usedBill = new Set<string>();
  const usedEob = new Set<string>();

  // 1. One-to-one matches, strongest first (greedy assignment by score).
  const pairs = billLines.flatMap((b) =>
    eobLines.map((e) => ({ b, e, ...score(b, e) })).filter((p) => p.score > 0),
  );
  pairs.sort((x, y) => y.score - x.score);
  for (const p of pairs) {
    if (usedBill.has(p.b.id) || usedEob.has(p.e.id)) continue;
    usedBill.add(p.b.id);
    usedEob.add(p.e.id);
    matches.push({ eobLineId: p.e.id, billLineIds: [p.b.id], how: p.how });
  }

  // 2. Grouped matches: an EOB line whose billed amount equals the sum of several bill lines
  //    from the same date (insurers often roll lab or supply lines into one).
  for (const e of eobLines) {
    if (usedEob.has(e.id)) continue;
    const candidates = billLines.filter((b) => !usedBill.has(b.id) && b.dateOfService === e.dateOfService);
    const group = findGroup(candidates, e.billed);
    if (!group) continue;
    usedEob.add(e.id);
    group.forEach((b) => usedBill.add(b.id));
    matches.push({ eobLineId: e.id, billLineIds: group.map((b) => b.id), how: 'grouped' });
  }

  return {
    matches,
    unmatchedBillLineIds: billLines.filter((b) => !usedBill.has(b.id)).map((b) => b.id),
    unmatchedEobLineIds: eobLines.filter((e) => !usedEob.has(e.id)).map((e) => e.id),
  };
}

/**
 * Compares the bill with its EOBs:
 * - insurance_balance: the bill asks for more than the patient can owe (billing error)
 * - insurance_missing: a charge no EOB covers, so it may never have gone to the insurer
 * - insurance_charge: the patient was billed a different charge than the insurer was
 */
export function reconcile(
  billLines: LineItem[],
  eobs: Eob[],
  amountDue: number | undefined,
  /** Lines already disputed in full by the audit (a duplicate, say). They still take part in
   *  matching, but aren't reported as missing or counted toward what the patient owes. */
  disputedLineIds: Set<string> = new Set(),
): Reconciliation {
  const eobLines = eobs.flatMap((e) => e.lines);
  const byEobLine = new Map(eobLines.map((l) => [l.id, l]));
  const byBillLine = new Map(billLines.map((l) => [l.id, l]));
  const { matches, unmatchedBillLineIds, unmatchedEobLineIds } = matchLines(billLines, eobLines);

  const missing = findingFactory('insurance_missing');
  const charge = findingFactory('insurance_charge');
  const balance = findingFactory('insurance_balance');
  const findings: Finding[] = [];

  for (const id of unmatchedBillLineIds) {
    if (disputedLineIds.has(id)) continue;
    const line = byBillLine.get(id)!;
    findings.push(
      missing({
        category: 'insurance_issue',
        lineItemIds: [id],
        amount: line.charge,
        message: `Code ${line.code} (${money(line.charge)} on ${line.dateOfService}) doesn't appear on any insurance statement you added. It may not have been submitted to your insurer.`,
        evidence: { code: line.code, charge: line.charge, dateOfService: line.dateOfService },
      }),
    );
  }

  for (const m of matches) {
    if (m.how === 'grouped') continue; // a grouped match already agrees on the total
    const bill = byBillLine.get(m.billLineIds[0])!;
    const eob = byEobLine.get(m.eobLineId)!;
    const diff = round2(bill.charge - eob.billed);
    if (diff > TOLERANCE) {
      findings.push(
        charge({
          category: 'insurance_issue',
          lineItemIds: [bill.id],
          amount: diff,
          message: `Code ${bill.code} is billed to you at ${money(bill.charge)}, but your insurer was billed ${money(eob.billed)} for it.`,
          evidence: { code: bill.code, billedToYou: bill.charge, billedToInsurer: eob.billed, eobId: eob.eobId },
        }),
      );
    }
  }

  const patientResponsibility = round2(
    matches.reduce((s, m) => s + byEobLine.get(m.eobLineId)!.patientResponsibility, 0),
  );
  const uncovered = round2(
    unmatchedBillLineIds.filter((id) => !disputedLineIds.has(id)).reduce((s, id) => s + byBillLine.get(id)!.charge, 0),
  );
  const maxExpectedDue = round2(patientResponsibility + uncovered);

  if (amountDue !== undefined && matches.length > 0 && amountDue - maxExpectedDue > TOLERANCE) {
    findings.push(
      balance({
        category: 'billing_error',
        lineItemIds: [],
        amount: amountDue - maxExpectedDue,
        message:
          `This bill asks you to pay ${money(amountDue)}, but your insurance statements say you owe ${money(patientResponsibility)} for the services they cover` +
          (uncovered > 0 ? `, plus ${money(uncovered)} in charges they don't list` : '') +
          `. That's ${money(amountDue - maxExpectedDue)} more than you should owe.`,
        evidence: { amountDue, patientResponsibility, uncoveredCharges: uncovered, maxExpectedDue },
      }),
    );
  }

  return { matches, unmatchedBillLineIds, unmatchedEobLineIds, patientResponsibility, maxExpectedDue, findings };
}
