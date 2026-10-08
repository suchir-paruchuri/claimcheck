import { checkDuplicates } from '../src/rules/checks/duplicates';
import { checkMath } from '../src/rules/checks/math';
import { checkNotReceived } from '../src/rules/checks/notReceived';
import { checkOutsideStay } from '../src/rules/checks/outsideStay';
import { checkPricing } from '../src/rules/checks/pricing';
import { checkUnbundling } from '../src/rules/checks/unbundling';
import { checkUnitLimits } from '../src/rules/checks/unitLimits';
import type { FeeScheduleRate, MueLimit, NcciEdit } from '../src/domain/types';
import { bill, item } from './helpers';

describe('duplicates', () => {
  it('flags the repeated charges for the same code, date, units and modifiers', () => {
    const f = checkDuplicates(bill([item({ code: '85025', charge: 40 }), item({ code: '85025', charge: 40 }), item({ code: '85025', charge: 40 })]));
    expect(f).toHaveLength(1);
    expect(f[0].amount).toBe(80);
    expect(f[0].lineItemIds).toHaveLength(3);
  });

  it('does not flag different dates, units, or modifiers', () => {
    const f = checkDuplicates(
      bill([
        item({ code: '85025' }),
        item({ code: '85025', dateOfService: '2026-08-02' }),
        item({ code: '85025', units: 2 }),
        item({ code: '85025', modifiers: ['91'] }),
      ]),
    );
    expect(f).toHaveLength(0);
  });

  it('treats modifier order as irrelevant', () => {
    expect(checkDuplicates(bill([item({ modifiers: ['25', 'GT'] }), item({ modifiers: ['GT', '25'] })]))).toHaveLength(1);
  });
});

describe('math', () => {
  it('flags units x unit price that does not match the charge', () => {
    const f = checkMath(bill([item({ units: 3, unitPrice: 20, charge: 80 })]));
    expect(f).toHaveLength(1);
    expect(f[0].amount).toBe(20);
  });

  it('flags a stated total that does not equal the line items', () => {
    const f = checkMath(bill([item({ charge: 100 }), item({ charge: 50 })], { statedTotal: 175 }));
    expect(f).toHaveLength(1);
    expect(f[0].evidence.lineItemSum).toBe(150);
  });

  it('allows a one-cent rounding tolerance', () => {
    expect(checkMath(bill([item({ units: 3, unitPrice: 33.33, charge: 100 })], { statedTotal: 100 }))).toHaveLength(0);
  });
});

describe('unbundling (NCCI)', () => {
  const edit = (o: Partial<NcciEdit> = {}): NcciEdit => ({
    column1: '29881', column2: '29877', version: 'practitioner', modifierIndicator: 1,
    effectiveDate: '2020-01-01', dataVersion: 'NCCI 2026 Q4', ...o,
  });

  it('flags the column-two code billed with its column-one code on the same date', () => {
    const f = checkUnbundling(bill([item({ code: '29881', charge: 900 }), item({ code: '29877', charge: 400 })]), [edit()], 'practitioner');
    expect(f).toHaveLength(1);
    expect(f[0].amount).toBe(400);
  });

  it('does not flag an indicator-1 pair when a distinct-service modifier is reported', () => {
    const f = checkUnbundling(bill([item({ code: '29881' }), item({ code: '29877', modifiers: ['59'] })]), [edit()], 'practitioner');
    expect(f).toHaveLength(0);
  });

  it('flags an indicator-0 pair even with a modifier', () => {
    const f = checkUnbundling(bill([item({ code: '29881' }), item({ code: '29877', modifiers: ['59'] })]), [edit({ modifierIndicator: 0 })], 'practitioner');
    expect(f).toHaveLength(1);
  });

  it('ignores edits from the other table version', () => {
    expect(checkUnbundling(bill([item({ code: '29881' }), item({ code: '29877' })]), [edit({ version: 'hospital' })], 'practitioner')).toHaveLength(0);
  });

  it('ignores edits outside their effective dates', () => {
    const items = [item({ code: '29881' }), item({ code: '29877' })];
    expect(checkUnbundling(bill(items), [edit({ deletionDate: '2026-01-01' })], 'practitioner')).toHaveLength(0);
    expect(checkUnbundling(bill(items), [edit({ effectiveDate: '2026-12-01' })], 'practitioner')).toHaveLength(0);
  });

  it('does not pair services on different dates', () => {
    expect(checkUnbundling(bill([item({ code: '29881' }), item({ code: '29877', dateOfService: '2026-08-05' })]), [edit()], 'practitioner')).toHaveLength(0);
  });
});

describe('unit limits (MUE)', () => {
  const mue = (o: Partial<MueLimit> = {}): MueLimit => ({ code: '96372', version: 'practitioner', limit: 4, mai: 3, dataVersion: 'MUE 2026 Q4', ...o });

  it('sums units across lines on the same date for per-day limits', () => {
    const f = checkUnitLimits(bill([item({ code: '96372', units: 3, charge: 300 }), item({ code: '96372', units: 3, charge: 300 })]), [mue()], 'practitioner');
    expect(f).toHaveLength(1);
    expect(f[0].amount).toBe(200); // 2 excess units at $100 each
  });

  it('checks each line separately for per-line (MAI 1) limits', () => {
    const items = [item({ code: '96372', units: 3 }), item({ code: '96372', units: 3 })];
    expect(checkUnitLimits(bill(items), [mue({ mai: 1 })], 'practitioner')).toHaveLength(0);
    expect(checkUnitLimits(bill([item({ code: '96372', units: 5, charge: 500 })]), [mue({ mai: 1 })], 'practitioner')[0].amount).toBe(100);
  });

  it('never flags a code with no published limit', () => {
    expect(checkUnitLimits(bill([item({ code: '99999', units: 50 })]), [mue()], 'practitioner')).toHaveLength(0);
  });
});

describe('pricing', () => {
  const rates: FeeScheduleRate[] = [
    { schedule: 'PFS', code: '99213', nonFacilityRate: 100, facilityRate: 70, version: 'PFS 2026 Oct' },
    { schedule: 'OPPS', code: '99283', rate: 250, version: 'OPPS 2026 Jul' },
    { schedule: 'OPPS', code: '96374', packaged: true, version: 'OPPS 2026 Jul' },
    { schedule: 'CLFS', code: '85025', rate: 7.77, version: 'CLFS 2026 Q4' },
  ];

  it('flags charges above the multiplier and shows the calculation', () => {
    const { findings } = checkPricing(bill([item({ code: '99213', charge: 350 })]), rates, 3);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('pricing_concern');
    expect(findings[0].evidence).toMatchObject({ medicareBenchmark: 100, ratio: 3.5, threshold: 3, source: 'PFS, non-facility' });
  });

  it('uses the facility rate when the place of service is a facility', () => {
    const { priced } = checkPricing(bill([item({ code: '99213', charge: 140, placeOfService: '23' })]), rates, 3);
    expect(priced[0]).toMatchObject({ benchmark: 70, ratio: 2 });
  });

  it('reports a ratio for every priced line, not only flagged ones', () => {
    const { findings, priced } = checkPricing(bill([item({ code: '99213', charge: 150 })]), rates, 3);
    expect(findings).toHaveLength(0);
    expect(priced).toHaveLength(1);
  });

  it('skips packaged outpatient codes', () => {
    const { priced } = checkPricing(bill([item({ code: '96374', charge: 5000 })], { billType: 'outpatient' }), rates, 3);
    expect(priced).toHaveLength(0);
  });

  it('prices outpatient lab tests with the lab fee schedule', () => {
    const { findings } = checkPricing(bill([item({ code: '85025', charge: 120 })], { billType: 'outpatient' }), rates, 3);
    expect(findings[0].evidence.source).toBe('CLFS');
  });

  it('multiplies the benchmark by units', () => {
    const { priced } = checkPricing(bill([item({ code: '85025', units: 2, charge: 31.08 })]), rates, 3);
    expect(priced[0]).toMatchObject({ benchmark: 15.54, ratio: 2 });
  });
});

describe('not received', () => {
  it('flags only items the patient marked', () => {
    const f = checkNotReceived(bill([item({ notReceived: true, charge: 75 }), item()]));
    expect(f).toHaveLength(1);
    expect(f[0].amount).toBe(75);
  });
});

describe('charges outside the stay', () => {
  const stay = { billType: 'inpatient' as const, admissionDate: '2026-08-10', dischargeDate: '2026-08-14' };

  it('flags charges after discharge', () => {
    const f = checkOutsideStay(bill([item({ dateOfService: '2026-08-15' })], stay));
    expect(f[0].category).toBe('billing_error');
  });

  it('flags charges more than 3 days before admission', () => {
    const f = checkOutsideStay(bill([item({ dateOfService: '2026-08-06' })], stay));
    expect(f[0].category).toBe('billing_error');
  });

  it('only adds a note for charges inside the 3-day preadmission window', () => {
    const f = checkOutsideStay(bill([item({ dateOfService: '2026-08-07' })], stay));
    expect(f).toHaveLength(1);
    expect(f[0].category).toBe('info');
    expect(f[0].amount).toBe(0);
  });

  it('does not flag charges during the stay', () => {
    expect(checkOutsideStay(bill([item({ dateOfService: '2026-08-12' })], stay))).toHaveLength(0);
  });
});
