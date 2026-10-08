import type { FeeScheduleRate, MueLimit, NcciEdit, ReferenceData } from '../domain/types';
import { FeeSchedule } from '../models/FeeSchedule';
import { MueLimitModel, NcciEditModel } from '../models/CodingRules';

/**
 * Fetches all reference data a bill needs in one indexed query per collection ($in on the
 * bill's codes), instead of one query per line item.
 */
export async function loadReferenceData(codes: string[]): Promise<ReferenceData> {
  const [rates, ncciEdits, mueLimits] = await Promise.all([
    FeeSchedule.find({ code: { $in: codes } }).lean(),
    NcciEditModel.find({ column1: { $in: codes }, column2: { $in: codes } }).lean(),
    MueLimitModel.find({ code: { $in: codes } }).lean(),
  ]);
  return {
    rates: rates.map((r) => ({ ...r, modifier: r.modifier ?? undefined })) as unknown as FeeScheduleRate[],
    ncciEdits: ncciEdits as unknown as NcciEdit[],
    mueLimits: mueLimits as unknown as MueLimit[],
  };
}

/** CMS descriptions for extraction verification, preferring PFS, then OPPS, then CLFS. */
export async function loadCmsDescriptions(codes: string[]): Promise<Map<string, string>> {
  const rows = await FeeSchedule.find({ code: { $in: codes } }).select('code schedule description').lean();
  const order = { PFS: 0, OPPS: 1, CLFS: 2 } as const;
  rows.sort((a, b) => order[a.schedule as keyof typeof order] - order[b.schedule as keyof typeof order]);
  const map = new Map<string, string>();
  for (const r of rows) if (r.description && !map.has(r.code)) map.set(r.code, r.description);
  return map;
}
