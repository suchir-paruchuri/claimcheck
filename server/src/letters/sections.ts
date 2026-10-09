import type { Finding } from '../domain/types';

/**
 * What each letter paragraph must state so the billing office can act on it, and a plain
 * template paragraph used when the model's version doesn't pass validation.
 */

const usd = (n: unknown) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "2026-09-14" → "September 14, 2026". Anything else is returned unchanged. */
export function longDate(iso: unknown): string {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(iso ?? '');
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

export interface RequiredFacts {
  /** Dollar amounts, to the cent. */
  amounts: number[];
  codes: string[];
  /** Exact phrases, such as the date of service written out ("September 14, 2026"). */
  phrases: string[];
  /** Whole numbers that must appear, such as billed units and the Medicare limit. */
  counts: number[];
}

/** What a paragraph about this finding has to state for the billing office to act on it. */
export function requiredFacts(f: Finding): RequiredFacts {
  const e = f.evidence as Record<string, unknown>;
  const codes = [e.code, e.column1, e.column2].filter((c): c is string => typeof c === 'string');
  const pick = (...keys: string[]) => keys.map((k) => num(e[k])).filter((v): v is number => v !== undefined);
  const phrases = typeof e.dateOfService === 'string' ? [longDate(e.dateOfService)] : [];
  const counts = f.checkId === 'unit_limits' ? pick('billedUnits', 'limit') : [];
  const amounts =
    f.checkId === 'pricing' ? pick('billedCharge', 'medicareBenchmark')
    : f.checkId === 'insurance_charge' ? pick('billedToYou', 'billedToInsurer')
    : f.checkId === 'insurance_balance' ? pick('amountDue', 'maxExpectedDue')
    : [f.amount];
  return { amounts, codes, phrases, counts };
}

/** Whether the text names this whole number ("3 units", "limit of 2"), not as part of a larger number. */
export const mentionsCount = (text: string, n: number) => new RegExp(`(?<![\\d.,$])${n}(?![\\d.,]\\d)`).test(text);

/** Lowercases a description's first word for mid-sentence use, but leaves acronyms like CBC alone. */
const midSentence = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const named = (code: unknown, service?: string) => `code ${code}${service ? ` (${midSentence(service)})` : ''}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A plain, first-person paragraph built straight from the finding's audit data. */
export function templateSection(f: Finding, services: string[] = []): string {
  const e = f.evidence as Record<string, unknown>;
  const svc = services[0];
  const on = e.dateOfService ? ` on ${longDate(e.dateOfService)}` : '';
  switch (f.checkId) {
    case 'duplicates':
      return `${cap(named(e.code, svc))} is billed ${e.occurrences === 2 ? 'twice' : `${e.occurrences} times`}${on}, with identical units and modifiers. Please remove the repeated charges, which total ${usd(f.amount)}.`;
    case 'unbundling':
      return `${cap(named(e.column2, services[1] ?? svc))} is billed separately${on}, but under Medicare's National Correct Coding Initiative edits it is included in code ${e.column1} when both are billed on the same day, and no modifier indicates a separate, distinct service. Please remove the ${usd(f.amount)} charge.`;
    case 'unit_limits':
      return `${cap(named(e.code, svc))} is billed for ${e.billedUnits} units${on}, but Medicare's limit for this service is ${e.limit} per ${e.appliesTo === 'claim line' ? 'line' : 'day'}. Please remove the extra units, which account for ${usd(f.amount)}.`;
    case 'math':
      return e.statedTotal !== undefined
        ? `My bill's stated total does not match the sum of its line items. Please correct the ${usd(f.amount)} difference.`
        : `${cap(named(e.code, svc))} lists ${e.units} units at ${usd(e.unitPrice)}, which comes to ${usd(e.expected)}, but the line is billed at ${usd(e.billed)}. Please correct the ${usd(f.amount)} difference.`;
    case 'not_received':
      return `I did not receive the service billed under ${named(e.code, svc)}${on}. Please remove this ${usd(f.amount)} charge.`;
    case 'outside_stay':
      return `${cap(named(e.code, svc))}${on} falls outside the dates of my hospital stay. Please remove this ${usd(f.amount)} charge or explain it.`;
    case 'pricing':
      return `${cap(named(e.code, svc))} is billed at ${usd(e.billedCharge)}, about ${Math.round(Number(e.ratio))} times the Medicare rate of ${usd(e.medicareBenchmark)} for this service. Please explain how this charge was set, or reduce it.`;
    case 'insurance_missing':
      return `${cap(named(e.code, svc))}, billed at ${usd(e.charge)}${on}, does not appear on my insurer's Explanation of Benefits. Please confirm whether this charge was submitted to my insurer, and submit it if it was not, before billing me for it.`;
    case 'insurance_charge': {
      const payer = e.payer ? `${e.payer}'s statement${e.claimNumber ? ` for claim ${e.claimNumber}` : ''}` : "my insurer's statement";
      return `${cap(named(e.code, svc))} is billed to me at ${usd(e.billedToYou)}, but ${payer} shows that ${usd(e.billedToInsurer)} was billed to my insurer for the same service. Please correct my bill to match, or explain the ${usd(f.amount)} difference.`;
    }
    case 'insurance_balance':
      return `This bill asks me to pay ${usd(e.amountDue)}, but according to my insurer's Explanation of Benefits I should owe at most ${usd(e.maxExpectedDue)}. Some of this difference may be resolved by the other corrections in this letter; please send a corrected balance once they are made.`;
    default:
      return `${f.message} Please correct or explain this charge.`;
  }
}
