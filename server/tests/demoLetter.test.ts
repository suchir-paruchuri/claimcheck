// The frontend demo ships a pre-written letter; it must pass the same checks as Gemini's output.
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateLetterSections } from '../src/letters/letter';
import type { Finding } from '../src/domain/types';

const demo = (file: string) => JSON.parse(readFileSync(join(__dirname, '../../client/src/api', file), 'utf8'));

test('the demo letter covers every sample finding with audited amounts and no internal IDs', () => {
  const findings = [...demo('demoAudit.json').findings, ...demo('demoEob.json').findings] as Finding[];
  const sections = Object.entries(demo('demoLetter.json') as Record<string, string>).map(([findingId, explanation]) => ({ findingId, explanation }));
  expect(validateLetterSections({ sections }, findings)).toMatchObject({ ok: true, errors: [] });
});
