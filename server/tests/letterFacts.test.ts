import { readFileSync } from 'fs';
import { join } from 'path';
import { sectionsWithFallback, validateLetterSections } from '../src/letters/letter';
import { templateSection } from '../src/letters/sections';
import type { Finding } from '../src/domain/types';

const demo = (file: string) => JSON.parse(readFileSync(join(__dirname, '../../client/src/api', file), 'utf8'));
const findings = [...demo('demoAudit.json').findings, ...demo('demoEob.json').findings] as Finding[];
const byCheck = (checkId: string) => findings.find((f) => f.checkId === checkId)!;

describe('letter facts', () => {
  it('rejects vague paragraphs that leave out the amounts and codes', () => {
    const pricing = byCheck('pricing');
    const r = validateLetterSections(
      { sections: [{ findingId: pricing.id, explanation: 'For Code 99214 (Office visit), the charge is higher than the Medicare rate. Please explain how this charge was set or reduce it.' }] },
      [pricing],
    );
    expect(r.errors).toEqual(expect.arrayContaining(['Finding "pricing-1" must state $410.00.', 'Finding "pricing-1" must state $135.61.']));
  });

  it('requires both codes for unbundling', () => {
    const f = byCheck('unbundling');
    const r = validateLetterSections({ sections: [{ findingId: f.id, explanation: 'The glucose test is billed separately for $48.00. Please remove it.' }] }, [f]);
    expect(r.errors).toEqual(expect.arrayContaining(['Finding "unbundling-1" must name code 80053.', 'Finding "unbundling-1" must name code 82947.']));
  });

  it('template paragraphs pass validation for every kind of sample finding', () => {
    const sections = findings.map((f) => ({ findingId: f.id, explanation: templateSection(f, ['Sample service']) }));
    expect(validateLetterSections({ sections }, findings)).toMatchObject({ ok: true });
  });

  it('keeps the model paragraphs that pass and templates the rest', () => {
    const good = { findingId: 'duplicates-1', explanation: 'Code 85025 (CBC) is billed twice on September 14, 2026. Please remove the repeated $64.00 charge.' };
    const bad = { findingId: 'pricing-1', explanation: 'Code 99214 is expensive. Please reduce it.' };
    const { sections, templated } = sectionsWithFallback({ sections: [good, bad] }, findings);
    expect(sections.find((s) => s.findingId === 'duplicates-1')!.explanation).toBe(good.explanation);
    expect(templated).toContain('pricing-1');
    expect(sections.find((s) => s.findingId === 'pricing-1')!.explanation).toMatch(/\$410\.00.*\$135\.61/);
    expect(validateLetterSections({ sections }, findings).ok).toBe(true);
  });

  it('templates everything when the model output is unusable', () => {
    const { sections, templated } = sectionsWithFallback({ nonsense: true }, findings);
    expect(templated).toHaveLength(findings.length);
    expect(validateLetterSections({ sections }, findings).ok).toBe(true);
  });
});
