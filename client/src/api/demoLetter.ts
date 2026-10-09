// The demo's letter sections, one per sample finding (demoLetter.json). They pass the same
// validation the server applies to Gemini's output (every finding covered, every dollar amount
// from the audit, no internal IDs); see server/tests/demoLetter.test.ts.
import type { Finding } from './types';
import sections from './demoLetter.json';

export const DEMO_SECTIONS: Record<string, string> = sections;

/** A section for a finding the demo adds on the fly (a line the visitor marks as not received). */
export function fallbackSection(f: Finding): string {
  if (f.checkId === 'not_received') {
    const e = f.evidence as { code?: string };
    return `I did not receive the service billed under code ${e.code ?? ''}, charged at $${f.amount.toFixed(2)}. Please remove this charge.`;
  }
  return f.message;
}
