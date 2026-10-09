import { parseMueRecord, parseNcciLine, toIsoDate } from '../src/import/codingRuleParsers';

const filter = { since: '2024-01-01' };
const row = (deletion: string, indicator: string) =>
  `29881\t29877\t\t20060101\t${deletion}\t${indicator}\tMisuse of column two code with column one code\r`;

describe('NCCI line parser', () => {
  it('parses an active edit', () => {
    expect(parseNcciLine(row('*', '1'), 'practitioner', 'NCCI 2026 Q4', filter)).toEqual({
      column1: '29881', column2: '29877', version: 'practitioner', modifierIndicator: 1,
      effectiveDate: '2006-01-01', deletionDate: undefined, dataVersion: 'NCCI 2026 Q4',
    });
  });

  it('keeps edits deleted inside the lookback window', () => {
    expect(parseNcciLine(row('20250630', '0'), 'hospital', 'v', filter)?.deletionDate).toBe('2025-06-30');
  });

  it('skips edits deleted before the lookback window', () => {
    expect(parseNcciLine(row('20231231', '1'), 'hospital', 'v', filter)).toBeNull();
  });

  it('skips indicator-9 (not applicable) edits', () => {
    expect(parseNcciLine(row('*', '9'), 'hospital', 'v', filter)).toBeNull();
  });

  it('skips header lines', () => {
    expect(parseNcciLine('Column 1\tColumn 2\t*=in existence\tEffective\tDeletion\tModifier\tPTP Edit Rationale', 'hospital', 'v', filter)).toBeNull();
  });

  it('converts dates', () => {
    expect(toIsoDate('20261001')).toBe('2026-10-01');
    expect(toIsoDate('*')).toBeUndefined();
  });
});

describe('MUE record parser', () => {
  it('reads the limit and the adjudication indicator digit', () => {
    expect(parseMueRecord(['96372', '4', '3 Date of Service Edit: Clinical', 'Clinical: Data'], 'practitioner', 'v')).toEqual({
      code: '96372', version: 'practitioner', limit: 4, mai: 3, dataVersion: 'v',
    });
  });

  it('skips the license preamble and header', () => {
    expect(parseMueRecord(['HCPCS/\nCPT Code', 'Practitioner Services MUE Values', 'MUE Adjudication Indicator'], 'practitioner', 'v')).toBeNull();
    expect(parseMueRecord(['Current Procedural Terminology (CPT) codes...'], 'practitioner', 'v')).toBeNull();
  });
});
