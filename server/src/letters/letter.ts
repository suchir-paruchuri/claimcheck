import { z } from 'zod';
import type { Finding } from '../domain/types';

/** What Gemini must return: one explanation per finding, keyed by finding ID. */
export const LetterSectionsSchema = z.object({
  sections: z
    .array(
      z.object({
        findingId: z.string().min(1),
        explanation: z.string().min(20).max(1500),
      }),
    )
    .min(1),
});
export type LetterSections = z.infer<typeof LetterSectionsSchema>;

/** JSON Schema passed to Gemini's structured-output setting. */
export const letterSectionsJsonSchema = z.toJSONSchema(LetterSectionsSchema);

const AMOUNT_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g;

/** Every dollar amount a finding legitimately refers to. */
function allowedAmounts(f: Finding): Set<string> {
  const evidence = Object.values(f.evidence).filter((v): v is number => typeof v === 'number');
  // A pricing concern asks the provider to explain or reduce a charge, so the letter quotes the
  // charge and the Medicare rate but not the difference, which would read as a demand to remove it.
  const values = f.category === 'pricing_concern' ? evidence : [f.amount, ...evidence];
  return new Set(values.map((v) => v.toFixed(2)));
}

export interface LetterValidation {
  ok: boolean;
  errors: string[];
  sections?: LetterSections['sections'];
}

/**
 * Validates the model's output before any letter is built:
 * schema shape, every finding covered exactly once, no unknown findings,
 * and every dollar amount mentioned matching that finding's audit data.
 */
/** App-internal IDs (bill lines, statements) that mean nothing to a billing office. */
const INTERNAL_ID_RE = /\b(?:li-\d+|eob-[\w-]+)\b/i;

export function validateLetterSections(raw: unknown, findings: Finding[]): LetterValidation {
  const parsed = LetterSectionsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };

  const errors: string[] = [];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const seen = new Set<string>();

  for (const s of parsed.data.sections) {
    const finding = byId.get(s.findingId);
    if (!finding) { errors.push(`Unknown finding ID "${s.findingId}".`); continue; }
    const internal = s.explanation.match(INTERNAL_ID_RE) ?? findings.find((f) => s.explanation.includes(f.id))?.id;
    if (internal) errors.push(`Finding "${s.findingId}" mentions the internal ID "${internal}". Leave IDs out of the letter.`);
    if (seen.has(s.findingId)) errors.push(`Finding "${s.findingId}" is covered more than once.`);
    seen.add(s.findingId);

    const allowed = allowedAmounts(finding);
    for (const m of s.explanation.matchAll(AMOUNT_RE)) {
      const value = Number(m[1].replace(/,/g, '')).toFixed(2);
      if (allowed.has(value)) continue;
      if (finding.category === 'pricing_concern' && value === finding.amount.toFixed(2))
        errors.push(`Finding "${s.findingId}" states $${value} as an amount to dispute. For a pricing concern, give only the charge and the Medicare rate and ask for an explanation or reduction.`);
      else errors.push(`Finding "${s.findingId}" mentions $${value}, which is not in the audit data.`);
    }
  }
  for (const f of findings) if (!seen.has(f.id)) errors.push(`Finding "${f.id}" is missing from the letter.`);

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], sections: parsed.data.sections };
}

export interface LetterContext {
  patientName: string;
  providerName?: string;
  accountNumber?: string;
  date: string;
}

/** Builds the final letter from a template using only validated explanations. */
export function buildLetter(ctx: LetterContext, findings: Finding[], sections: LetterSections['sections']): string {
  const text = new Map(sections.map((s) => [s.findingId, s.explanation]));
  const errors = findings.filter((f) => f.category === 'billing_error');
  const pricing = findings.filter((f) => f.category === 'pricing_concern');
  const insurance = findings.filter((f) => f.category === 'insurance_issue');

  const lines = [
    ctx.date,
    '',
    `To the billing department${ctx.providerName ? ` of ${ctx.providerName}` : ''}:`,
    '',
    `I am writing to dispute charges on my itemized bill${ctx.accountNumber ? ` (account ${ctx.accountNumber})` : ''}. ` +
      'I reviewed each line item and identified the following issues.',
  ];
  if (errors.length) {
    lines.push('', 'Billing errors to correct:');
    errors.forEach((f, i) => lines.push(`${i + 1}. ${text.get(f.id)}`));
  }
  if (pricing.length) {
    lines.push('', 'Charges I am asking you to justify or reduce:');
    pricing.forEach((f, i) => lines.push(`${i + 1}. ${text.get(f.id)}`));
  }
  if (insurance.length) {
    lines.push('', 'Charges to reconcile with my insurance:');
    insurance.forEach((f, i) => lines.push(`${i + 1}. ${text.get(f.id)}`));
  }
  lines.push(
    '',
    'Please send a corrected itemized bill, and place my account on hold while these items are reviewed.',
    '',
    'Sincerely,',
    ctx.patientName,
  );
  return lines.join('\n');
}
