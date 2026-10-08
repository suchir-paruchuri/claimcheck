import fs from 'node:fs';
import { parse } from 'csv-parse';
import type { FeeScheduleName, FeeScheduleRate } from '../domain/types';

const num = (s: string | undefined) => {
  const n = Number((s ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** PFS status codes that carry a national payment amount (active, restricted, injections). */
const PFS_PAYABLE_STATUS = new Set(['A', 'R', 'T']);

/**
 * Each parser maps one CSV record to a rate, or null if the row has no usable price.
 * Column positions follow the 2026 CMS file layouts.
 */
export interface Layout {
  schedule: FeeScheduleName;
  /** Identifies the header row so preamble lines above it are skipped. */
  isHeader: (record: string[]) => boolean;
  toRate: (record: string[], version: string) => FeeScheduleRate | null;
}

export const PFS_LAYOUT: Layout = {
  schedule: 'PFS',
  isHeader: (r) => r[0]?.trim() === 'HCPCS' && r[1]?.trim() === 'MOD',
  toRate: (r, version) => {
    const [code, modifier, description, status] = r.map((c) => c?.trim());
    const nonFacilityRvu = num(r[11]);
    const facilityRvu = num(r[12]);
    const conversionFactor = num(r[25]);
    if (!code || !PFS_PAYABLE_STATUS.has(status) || (nonFacilityRvu <= 0 && facilityRvu <= 0)) return null;
    // The file gives relative value units; payment = total RVUs x conversion factor.
    return {
      schedule: 'PFS',
      code,
      modifier: modifier || undefined,
      description,
      nonFacilityRate: round2(nonFacilityRvu * conversionFactor),
      facilityRate: round2(facilityRvu * conversionFactor),
      version,
    };
  },
};

export const OPPS_LAYOUT: Layout = {
  schedule: 'OPPS',
  isHeader: (r) => r[0]?.trim() === 'HCPCS Code',
  toRate: (r, version) => {
    const [code, description, statusIndicator] = r.map((c) => c?.trim());
    if (!code) return null;
    // Status indicator N: packaged into another service, never separately paid.
    if (statusIndicator === 'N') return { schedule: 'OPPS', code, description, packaged: true, version };
    const rate = num(r[5]);
    return rate > 0 ? { schedule: 'OPPS', code, description, rate, version } : null;
  },
};

export const CLFS_LAYOUT: Layout = {
  schedule: 'CLFS',
  isHeader: (r) => r[0]?.trim() === 'YEAR' && r[1]?.trim() === 'HCPCS',
  toRate: (r, version) => {
    const code = r[1]?.trim();
    const rate = num(r[5]);
    if (!code || rate <= 0) return null;
    return { schedule: 'CLFS', code, modifier: r[2]?.trim() || undefined, description: r[6]?.trim(), rate, version };
  },
};

/**
 * Streams a CMS CSV row by row (constant memory regardless of file size), skipping the
 * preamble above the header and yielding rates.
 */
export async function* streamRates(path: string, layout: Layout, version: string): AsyncGenerator<FeeScheduleRate> {
  const parser = fs
    .createReadStream(path, { encoding: 'latin1' })
    .pipe(parse({ relax_column_count: true, relax_quotes: true, skip_empty_lines: true, bom: true }));

  let pastHeader = false;
  for await (const record of parser as AsyncIterable<string[]>) {
    if (!pastHeader) {
      pastHeader = layout.isHeader(record);
      continue;
    }
    const rate = layout.toRate(record, version);
    if (rate) yield rate;
  }
  if (!pastHeader) throw new Error(`No ${layout.schedule} header row found in ${path}; has the CMS file layout changed?`);
}
