import { descriptionSimilarity, totalsReconcile, verifyItem } from '../src/extraction/verify';
import { buildLetter, validateLetterSections } from '../src/letters/letter';
import type { Finding } from '../src/domain/types';

const page = '08/01/2026 99283 EMERGENCY DEPT VISIT MOD MDM 1 $850.00\n08/01/2026 85025 CBC W/AUTO DIFF 1 $112.00';

describe('verifyItem', () => {
  it('verifies an item whose code appears in the source text on the bill', () => {
    const v = verifyItem({ code: '99283', description: 'Emergency dept visit mod mdm', sourceText: '99283 EMERGENCY DEPT VISIT', charge: 850 }, [page], 'Emergency dept visit mod mdm');
    expect(v.extractionStatus).toBe('verified');
    expect(v.source).toEqual({ page: 1, text: '99283 EMERGENCY DEPT VISIT' });
  });

  it('catches a misread code that exists in CMS data with a similar description', () => {
    // The model read 99283 as 99285 and echoed a source text containing the wrong code.
    const v = verifyItem({ code: '99285', description: 'Emergency dept visit', sourceText: '99285 EMERGENCY DEPT VISIT', charge: 850 }, [page], 'Emergency dept visit hi mdm');
    expect(v.verification.foundInDocument).toBe(false);
    expect(v.extractionStatus).toBe('needs_review');
  });

  it('marks codes missing from CMS data as unverified, not invalid', () => {
    const v = verifyItem({ code: '85025', description: 'CBC', sourceText: '85025 CBC W/AUTO DIFF', charge: 112 }, [page], undefined);
    expect(v.extractionStatus).toBe('unverified');
  });

  it('flags a description that does not match the CMS descriptor', () => {
    const v = verifyItem({ code: '85025', description: 'Knee replacement', sourceText: '85025 CBC W/AUTO DIFF', charge: 112 }, [page], 'Complete cbc w/auto diff wbc');
    expect(v.extractionStatus).toBe('needs_review');
  });
});

describe('descriptionSimilarity', () => {
  it('matches abbreviations by prefix', () => {
    expect(descriptionSimilarity('Emergency department visit', 'Emergency dept visit hi mdm')).toBeGreaterThan(0.5);
  });

  it('matches a terse bill line against a wordier CMS descriptor', () => {
    expect(descriptionSimilarity('Routine venipuncture', 'Collj venous bld venipuncture')).toBeGreaterThanOrEqual(0.5);
  });

  it('scores unrelated descriptions low', () => {
    expect(descriptionSimilarity('Knee replacement', 'Complete cbc w/auto diff wbc')).toBe(0);
  });
});

describe('totalsReconcile', () => {
  it('compares line items to the stated total', () => {
    expect(totalsReconcile([850, 112], 962)).toBe(true);
    expect(totalsReconcile([850, 112], 1000)).toBe(false);
    expect(totalsReconcile([850], undefined)).toBeUndefined();
  });
});

describe('letter validation', () => {
  const findings: Finding[] = [
    { id: 'duplicates-1', checkId: 'duplicates', category: 'billing_error', lineItemIds: ['a', 'b'], amount: 112, message: '', evidence: { code: '85025' } },
    { id: 'pricing-1', checkId: 'pricing', category: 'pricing_concern', lineItemIds: ['c'], amount: 600, message: '', evidence: { billedCharge: 850, medicareBenchmark: 250 } },
  ];
  const good = {
    sections: [
      { findingId: 'duplicates-1', explanation: 'The CBC test (85025) appears twice on the same date; please remove the duplicate $112.00 charge.' },
      { findingId: 'pricing-1', explanation: 'The ER visit was billed at $850.00, compared with a Medicare benchmark of $250.00. Please justify or reduce it.' },
    ],
  };

  it('accepts output that covers every finding with audited amounts', () => {
    expect(validateLetterSections(good, findings)).toMatchObject({ ok: true });
  });

  it('rejects a missing finding', () => {
    const r = validateLetterSections({ sections: [good.sections[0]] }, findings);
    expect(r.errors).toContain('Finding "pricing-1" is missing from the letter.');
  });

  it('rejects an invented finding', () => {
    const r = validateLetterSections({ sections: [...good.sections, { findingId: 'made-up-1', explanation: 'You also overcharged me for an X-ray I never had.' }] }, findings);
    expect(r.ok).toBe(false);
  });

  it('rejects dollar amounts that are not in the audit', () => {
    const r = validateLetterSections(
      { sections: [good.sections[0], { findingId: 'pricing-1', explanation: 'This visit was overpriced by $1,400.00 and should be refunded.' }] },
      findings,
    );
    expect(r.errors[0]).toMatch(/\$1400.00/);
  });

  it('rejects stating the amount above the Medicare rate as a sum to remove for a pricing concern', () => {
    const pricing = findings.find((f) => f.category === 'pricing_concern')!;
    const r = validateLetterSections(
      {
        sections: good.sections.map((s) =>
          s.findingId === pricing.id ? { ...s, explanation: `${s.explanation} I am disputing the difference of $${pricing.amount.toFixed(2)}.` } : s,
        ),
      },
      findings,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects internal IDs that would mean nothing to a billing office', () => {
    const r = validateLetterSections(
      { sections: [good.sections[0], { ...good.sections[1], explanation: `${good.sections[1].explanation} See statement eob-1e5b052b.` }] },
      findings,
    );
    expect(r.errors.join(' ')).toMatch(/internal ID "eob-1e5b052b"/);
  });

  it('rejects output that does not match the schema', () => {
    expect(validateLetterSections({ text: 'Dear hospital...' }, findings).ok).toBe(false);
  });

  it('builds a letter with errors and pricing concerns in separate sections', () => {
    const letter = buildLetter({ patientName: 'Pat Doe', date: 'October 8, 2026' }, findings, good.sections);
    expect(letter).toMatch(/Billing errors to correct:\n1\. The CBC/);
    expect(letter).toMatch(/justify or reduce:\n1\. The ER visit/);
  });
});
