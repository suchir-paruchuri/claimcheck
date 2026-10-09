import { matchLines, reconcile, type Eob, type EobLine } from '../src/rules/reconcile';
import { item } from './helpers';

const eobLine = (o: Partial<EobLine> & Pick<EobLine, 'id' | 'billed' | 'patientResponsibility'>): EobLine => ({
  eobId: 'eob1',
  dateOfService: '2026-08-01',
  description: 'Medical service',
  ...o,
});
const eob = (lines: EobLine[]): Eob => ({ id: 'eob1', lines });

describe('matching bill lines to EOB lines', () => {
  it('matches by code even when the EOB description is different', () => {
    const r = matchLines([item({ id: 'b1', code: '99213', charge: 180 })], [eobLine({ id: 'e1', code: '99213', billed: 170, patientResponsibility: 30, description: 'Office visit' })]);
    expect(r.matches).toEqual([{ eobLineId: 'e1', billLineIds: ['b1'], how: 'code' }]);
  });

  it('matches by amount when the EOB omits codes', () => {
    const r = matchLines([item({ id: 'b1', code: '85025', charge: 64 })], [eobLine({ id: 'e1', billed: 64, patientResponsibility: 12 })]);
    expect(r.matches[0].how).toBe('amount');
  });

  it('matches an EOB line that groups several bill lines from the same date', () => {
    const bills = [item({ id: 'b1', code: '80053', charge: 186 }), item({ id: 'b2', code: '85025', charge: 64 }), item({ id: 'b3', code: '36415', charge: 25 })];
    const r = matchLines(bills, [eobLine({ id: 'e1', description: 'Laboratory', billed: 275, patientResponsibility: 40 })]);
    expect(r.matches).toEqual([{ eobLineId: 'e1', billLineIds: ['b1', 'b2', 'b3'], how: 'grouped' }]);
    expect(r.unmatchedBillLineIds).toEqual([]);
  });

  it('never matches services on different dates', () => {
    const r = matchLines([item({ id: 'b1', code: '99213', charge: 180, dateOfService: '2026-08-02' })], [eobLine({ id: 'e1', code: '99213', billed: 180, patientResponsibility: 30 })]);
    expect(r.matches).toHaveLength(0);
  });

  it('uses each line at most once, preferring the strongest match', () => {
    const bills = [item({ id: 'b1', code: '85025', charge: 64 }), item({ id: 'b2', code: '85025', charge: 64 })];
    const r = matchLines(bills, [eobLine({ id: 'e1', code: '85025', billed: 64, patientResponsibility: 10 })]);
    expect(r.matches).toHaveLength(1);
    expect(r.unmatchedBillLineIds).toHaveLength(1);
  });
});

describe('reconcile', () => {
  const bills = [
    item({ id: 'b1', code: '99214', charge: 410 }),
    item({ id: 'b2', code: '80053', charge: 186 }),
    item({ id: 'b3', code: '93000', charge: 145 }),
  ];
  const statement = eob([
    eobLine({ id: 'e1', code: '99214', billed: 380, patientResponsibility: 40 }),
    eobLine({ id: 'e2', code: '80053', billed: 186, patientResponsibility: 25 }),
  ]);

  it('flags a balance higher than the most the patient can owe', () => {
    const r = reconcile(bills, [statement], 612);
    const f = r.findings.find((x) => x.checkId === 'insurance_balance')!;
    expect(r.patientResponsibility).toBe(65);
    expect(r.maxExpectedDue).toBe(210); // $65 owed per the EOB + $145 the EOB doesn't cover
    expect(f.category).toBe('billing_error');
    expect(f.amount).toBe(402);
  });

  it('flags charges no EOB covers as possibly never submitted to insurance', () => {
    const f = reconcile(bills, [statement], undefined).findings.filter((x) => x.checkId === 'insurance_missing');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ category: 'insurance_issue', lineItemIds: ['b3'], amount: 145 });
  });

  it('flags a patient charge higher than what the insurer was billed', () => {
    const f = reconcile(bills, [statement], undefined).findings.find((x) => x.checkId === 'insurance_charge')!;
    expect(f).toMatchObject({ lineItemIds: ['b1'], amount: 30 });
  });

  it('does not flag a balance at or below what the EOBs allow', () => {
    expect(reconcile(bills, [statement], 210).findings.some((x) => x.checkId === 'insurance_balance')).toBe(false);
  });

  it('combines lines from several EOBs, such as separate hospital and doctor claims', () => {
    const second: Eob = { id: 'eob2', lines: [eobLine({ id: 'e3', eobId: 'eob2', code: '93000', billed: 145, patientResponsibility: 20 })] };
    const r = reconcile(bills, [statement, second], 85);
    expect(r.unmatchedBillLineIds).toEqual([]);
    expect(r.patientResponsibility).toBe(85);
    expect(r.findings.some((x) => x.checkId === 'insurance_balance')).toBe(false);
  });

  it('does not report or count lines the audit already disputes in full', () => {
    const r = reconcile(bills, [statement], 612, new Set(['b3']));
    expect(r.findings.some((x) => x.checkId === 'insurance_missing')).toBe(false);
    expect(r.maxExpectedDue).toBe(65); // the disputed $145 isn't treated as owed
  });

  it('makes no balance claim when nothing on the bill matches the statements', () => {
    const r = reconcile([item({ id: 'b9', code: '99999', charge: 50, dateOfService: '2026-01-01' })], [statement], 50);
    expect(r.findings.some((x) => x.checkId === 'insurance_balance')).toBe(false);
  });
});
