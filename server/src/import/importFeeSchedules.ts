/**
 * Loads the three Medicare fee schedules into MongoDB.
 *
 *   npm run import:fees -- --pfs <PPRRVU nonQPP.csv> --opps <Addendum B.csv> --clfs <CLFS.csv> \
 *     --pfs-version "PFS 2026 Oct (RVU26D)" --opps-version "OPPS 2026 Jul" --clfs-version "CLFS 2026 Q4" [--dry-run]
 *
 * Rows are streamed and written with unordered bulk upserts in batches, so memory stays flat.
 * --dry-run parses and counts without touching the database.
 */
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { config } from '../config';
import { FeeSchedule } from '../models/FeeSchedule';
import type { FeeScheduleRate } from '../domain/types';
import { CLFS_LAYOUT, OPPS_LAYOUT, PFS_LAYOUT, streamRates, type Layout } from './feeScheduleParsers';

const BATCH_SIZE = 1000;

async function importOne(path: string, layout: Layout, version: string, dryRun: boolean) {
  let batch: FeeScheduleRate[] = [];
  let priced = 0;
  let packaged = 0;

  const flush = async () => {
    if (dryRun || batch.length === 0) return (batch = []);
    await FeeSchedule.bulkWrite(
      batch.map((r) => ({
        updateOne: {
          filter: { schedule: r.schedule, code: r.code, modifier: r.modifier ?? null, version: r.version },
          update: { $set: { ...r, modifier: r.modifier ?? null } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    batch = [];
  };

  for await (const rate of streamRates(path, layout, version)) {
    if (rate.packaged) packaged++;
    else priced++;
    batch.push(rate);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
  console.log(`${layout.schedule}: ${priced.toLocaleString()} priced rates${packaged ? `, ${packaged.toLocaleString()} packaged codes` : ''} (${version})`);
  return priced;
}

async function main() {
  const { values } = parseArgs({
    options: {
      pfs: { type: 'string' }, opps: { type: 'string' }, clfs: { type: 'string' },
      'pfs-version': { type: 'string', default: 'PFS 2026 Oct (RVU26D)' },
      'opps-version': { type: 'string', default: 'OPPS 2026 Jul' },
      'clfs-version': { type: 'string', default: 'CLFS 2026 Q4' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dryRun = values['dry-run']!;
  if (!dryRun) await mongoose.connect(config.mongoUri);

  const started = Date.now();
  let total = 0;
  if (values.pfs) total += await importOne(values.pfs, PFS_LAYOUT, values['pfs-version']!, dryRun);
  if (values.opps) total += await importOne(values.opps, OPPS_LAYOUT, values['opps-version']!, dryRun);
  if (values.clfs) total += await importOne(values.clfs, CLFS_LAYOUT, values['clfs-version']!, dryRun);
  console.log(`Total: ${total.toLocaleString()} priced Medicare rates in ${((Date.now() - started) / 1000).toFixed(1)}s${dryRun ? ' (dry run)' : ''}`);

  if (!dryRun) {
    await FeeSchedule.syncIndexes();
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
