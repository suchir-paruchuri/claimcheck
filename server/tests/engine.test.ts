import { planChecks, runAudit } from '../src/rules/engine';
import { classifyBill } from '../src/rules/classify';
import type { ReferenceData } from '../src/domain/types';
import { bill, item } from './helpers';

const emptyRef: ReferenceData = { rates: [], ncciEdits: [], mueLimits: [] };

describe('check planning by bill type', () => {
  it('runs every line-level check for doctor and outpatient bills', () => {
    for (const billType of ['physician', 'outpatient'] as const) {
      const { run } = planChecks(bill([], { billType }));
      expect(run).toEqual(['duplicates', 'math', 'unbundling', 'unit_limits', 'pricing', 'not_received']);
    }
  });

  it('skips pricing and coding-rule checks for inpatient and uncertain bills, with reasons', () => {
    for (const billType of ['inpatient', 'uncertain'] as const) {
      const { run, skipped } = planChecks(bill([], { billType, admissionDate: '2026-08-01', dischargeDate: '2026-08-03' }));
      expect(run).toEqual(['duplicates', 'math', 'not_received', 'outside_stay']);
      expect(skipped.map((s) => s.checkId)).toEqual(['unbundling', 'unit_limits', 'pricing']);
      expect(skipped.every((s) => s.reason.length > 0)).toBe(true);
    }
  });

  it('skips the outside-stay check when stay dates are missing', () => {
    const { skipped } = planChecks(bill([], { billType: 'inpatient' }));
    expect(skipped.find((s) => s.checkId === 'outside_stay')?.reason).toMatch(/admission and a discharge date/);
  });
});

describe('runAudit', () => {
  it('uses hospital NCCI tables for outpatient bills', () => {
    const ref: ReferenceData = {
      ...emptyRef,
      ncciEdits: [{ column1: 'A', column2: 'B', version: 'hospital', modifierIndicator: 0, effectiveDate: '2020-01-01', dataVersion: 'v' }],
    };
    const result = runAudit(bill([item({ code: 'A' }), item({ code: 'B' })], { billType: 'outpatient' }), ref, { benchmarkMultiplier: 3 });
    expect(result.findings.map((f) => f.checkId)).toEqual(['unbundling']);
  });

  it('totals billing errors and pricing concerns separately', () => {
    const ref: ReferenceData = { ...emptyRef, rates: [{ schedule: 'PFS', code: '99213', nonFacilityRate: 100, facilityRate: 70, version: 'v' }] };
    const result = runAudit(
      bill([item({ code: '99213', charge: 400 }), item({ code: '99214', charge: 150, notReceived: true })]),
      ref,
      { benchmarkMultiplier: 3 },
    );
    expect(result.totals).toEqual({ billed: 550, billingErrors: 150, pricingConcerns: 300 });
  });

  it('does not double-count a repeated duplicate as a pricing concern', () => {
    const ref: ReferenceData = { ...emptyRef, rates: [{ schedule: 'CLFS', code: '85025', rate: 7.77, version: 'v' }] };
    const result = runAudit(bill([item({ code: '85025', charge: 42 }), item({ code: '85025', charge: 42 })]), ref, { benchmarkMultiplier: 3 });
    expect(result.findings.filter((f) => f.checkId === 'pricing')).toHaveLength(1);
    expect(result.totals.billingErrors).toBe(42);
    expect(result.totals.pricingConcerns).toBe(34.23);
  });

  it('does not price a code that is already disputed as unbundled', () => {
    const ref: ReferenceData = {
      rates: [{ schedule: 'CLFS', code: '82947', rate: 3.93, version: 'v' }],
      ncciEdits: [{ column1: '80053', column2: '82947', version: 'practitioner', modifierIndicator: 1, effectiveDate: '2000-07-01', dataVersion: 'v' }],
      mueLimits: [],
    };
    const result = runAudit(bill([item({ code: '80053', charge: 186 }), item({ code: '82947', charge: 48 })]), ref, { benchmarkMultiplier: 3 });
    expect(result.findings.map((f) => f.checkId)).toEqual(['unbundling']);
  });

  it('does not price line items on inpatient bills', () => {
    const ref: ReferenceData = { ...emptyRef, rates: [{ schedule: 'CLFS', code: '85025', rate: 7.77, version: 'v' }] };
    const result = runAudit(bill([item({ code: '85025', charge: 500 })], { billType: 'inpatient' }), ref, { benchmarkMultiplier: 3 });
    expect(result.findings).toHaveLength(0);
  });
});

describe('classifyBill', () => {
  it('treats bills without revenue or type-of-bill codes as doctor bills', () => {
    expect(classifyBill({ revenueCodes: [] }).billType).toBe('physician');
  });

  it('classifies room-and-board charges plus an admitted answer as inpatient', () => {
    expect(classifyBill({ revenueCodes: ['0120', '0450'], typeOfBill: '0111', answer: 'admitted' }).billType).toBe('inpatient');
  });

  it('classifies an overnight observation stay as outpatient', () => {
    const c = classifyBill({ revenueCodes: ['0762', '0450'], typeOfBill: '0131', admissionDate: '2026-08-01', dischargeDate: '2026-08-02', answer: 'unsure' });
    expect(c.billType).toBe('outpatient');
  });

  it('marks the bill uncertain when signals conflict with the answer', () => {
    expect(classifyBill({ revenueCodes: ['0120'], answer: 'not_admitted' }).billType).toBe('uncertain');
  });

  it('does not treat a multi-day stay alone as inpatient', () => {
    const c = classifyBill({ revenueCodes: ['0450'], admissionDate: '2026-08-01', dischargeDate: '2026-08-03', answer: 'unsure' });
    expect(c.billType).toBe('uncertain');
  });

  it('marks conflicting bill signals uncertain', () => {
    expect(classifyBill({ revenueCodes: ['0120', '0762'], answer: 'admitted' }).billType).toBe('uncertain');
  });
});
