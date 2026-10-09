import fs from 'node:fs';
import readline from 'node:readline';
import { parse } from 'csv-parse';
import type { MueLimit, NcciEdit, NcciVersion } from '../domain/types';

/** "20231231" -> "2023-12-31"; "*" (no date) -> undefined */
export function toIsoDate(raw: string): string | undefined {
  const s = raw.trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : undefined;
}

export interface NcciFilter {
  /** Keep edits deleted on or after this date, so bills from recent years can still be checked. */
  since: string; // YYYY-MM-DD
}

/**
 * One tab-separated PTP row: Column 1, Column 2, prior-to-1996 flag, Effective date,
 * Deletion date ("*" = still active), Modifier indicator (0, 1, or 9), rationale.
 * Returns null for header lines, indicator-9 rows (edit not applicable), and edits
 * deleted before the lookback window.
 */
export function parseNcciLine(line: string, version: NcciVersion, dataVersion: string, filter: NcciFilter): NcciEdit | null {
  const cols = line.replace(/\r$/, '').split('\t');
  if (cols.length < 6) return null;
  const effectiveDate = toIsoDate(cols[3]);
  if (!effectiveDate) return null; // header and preamble lines
  const indicator = cols[5].trim();
  if (indicator !== '0' && indicator !== '1') return null;
  const deletionDate = toIsoDate(cols[4]);
  if (deletionDate && deletionDate < filter.since) return null;
  return {
    column1: cols[0].trim(),
    column2: cols[1].trim(),
    version,
    modifierIndicator: indicator === '1' ? 1 : 0,
    effectiveDate,
    deletionDate,
    dataVersion,
  };
}

export interface NcciStreamStats {
  rows: number;
  kept: number;
  skippedNotApplicable: number;
  skippedOldDeletion: number;
}

/** Streams a PTP edit file line by line, so multi-million-row files use constant memory. */
export async function* streamNcciEdits(
  path: string,
  version: NcciVersion,
  dataVersion: string,
  filter: NcciFilter,
  stats: NcciStreamStats,
): AsyncGenerator<NcciEdit> {
  const lines = readline.createInterface({ input: fs.createReadStream(path, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 6 || !toIsoDate(cols[3] ?? '')) continue;
    stats.rows++;
    const edit = parseNcciLine(line, version, dataVersion, filter);
    if (edit) {
      stats.kept++;
      yield edit;
    } else if (!['0', '1'].includes(cols[5].trim())) stats.skippedNotApplicable++;
    else stats.skippedOldDeletion++;
  }
}

/**
 * One MUE CSV record: code, MUE value, adjudication indicator ("2 Date of Service Edit: Policy"),
 * rationale. Returns null for the license preamble and header.
 */
export function parseMueRecord(record: string[], version: NcciVersion, dataVersion: string): MueLimit | null {
  const [code, value, indicator] = record.map((c) => c?.trim() ?? '');
  if (!code || !/^\d+$/.test(value)) return null;
  const mai = Number(indicator.charAt(0));
  if (mai !== 1 && mai !== 2 && mai !== 3) return null;
  return { code, version, limit: Number(value), mai, dataVersion };
}

export async function* streamMueLimits(path: string, version: NcciVersion, dataVersion: string): AsyncGenerator<MueLimit> {
  const parser = fs
    .createReadStream(path, { encoding: 'latin1' })
    .pipe(parse({ relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true }));
  for await (const record of parser as AsyncIterable<string[]>) {
    const limit = parseMueRecord(record, version, dataVersion);
    if (limit) yield limit;
  }
}
