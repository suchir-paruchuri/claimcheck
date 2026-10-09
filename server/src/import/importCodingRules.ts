/**
 * Loads NCCI procedure-to-procedure edits and MUE limits into MongoDB.
 *
 *   npm run import:rules -- \
 *     --ncci-practitioner 'data/ncci/ccipra-v323r0-f*.txt' --ncci-hospital 'data/ncci/ccioph-v323r0-f*.txt' \
 *     --mue-practitioner data/ncci/MCR_MUE_PractitionerServices_Eff_10-01-2026.csv \
 *     --mue-hospital data/ncci/MCR_MUE_OutpatientHospitalServices_Eff_10-01-2026.csv \
 *     [--data-version "NCCI 2026 Q4"] [--since 2024-01-01] [--dry-run]
 *
 * Pass several files for one option by repeating it or using a quoted glob.
 * Each run replaces that version's rows, so re-importing a new quarter never leaves stale edits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import mongoose from 'mongoose';
import { config } from '../config';
import type { NcciVersion } from '../domain/types';
import { MueLimitModel, NcciEditModel } from '../models/CodingRules';
import { streamMueLimits, streamNcciEdits, type NcciStreamStats } from './codingRuleParsers';

const BATCH_SIZE = 5000;

/** Expands "dir/name-f*.txt" style globs (only * in the file name), case-insensitively. */
function expand(patterns: string[] = []): string[] {
  return patterns.flatMap((p) => {
    if (!p.includes('*')) return [p];
    const dir = path.dirname(p);
    const re = new RegExp(`^${path.basename(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
  });
}

async function writeBatches<T>(rows: AsyncIterable<T>, insert: (batch: T[]) => Promise<unknown>) {
  let batch: T[] = [];
  let count = 0;
  for await (const row of rows) {
    batch.push(row);
    count++;
    if (batch.length >= BATCH_SIZE) {
      await insert(batch);
      batch = [];
    }
  }
  if (batch.length) await insert(batch);
  return count;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'ncci-practitioner': { type: 'string', multiple: true },
      'ncci-hospital': { type: 'string', multiple: true },
      'mue-practitioner': { type: 'string' },
      'mue-hospital': { type: 'string' },
      'data-version': { type: 'string', default: 'NCCI 2026 Q4' },
      since: { type: 'string', default: '2024-01-01' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dryRun = values['dry-run']!;
  const dataVersion = values['data-version']!;
  const since = values.since!;
  if (!dryRun) await mongoose.connect(config.mongoUri);
  const started = Date.now();
  // Raw driver inserts: these rows are already validated by the parsers, and skipping
  // Mongoose document casting keeps multi-million-row imports fast.
  const insertMany = (model: typeof NcciEditModel | typeof MueLimitModel) => (batch: object[]) =>
    dryRun ? Promise.resolve() : model.collection.insertMany(batch.map((doc) => ({ ...doc })), { ordered: false });

  let totalEdits = 0;
  for (const version of ['practitioner', 'hospital'] as NcciVersion[]) {
    const files = expand(values[`ncci-${version}`]);
    if (!files.length) continue;
    if (!dryRun) await NcciEditModel.deleteMany({ version });
    const stats: NcciStreamStats = { rows: 0, kept: 0, skippedNotApplicable: 0, skippedOldDeletion: 0 };
    for (const file of files) {
      await writeBatches(streamNcciEdits(file, version, dataVersion, { since }, stats), insertMany(NcciEditModel));
    }
    totalEdits += stats.kept;
    console.log(
      `NCCI ${version}: ${stats.kept.toLocaleString()} edits loaded from ${stats.rows.toLocaleString()} rows in ${files.length} file(s) ` +
        `(skipped ${stats.skippedNotApplicable.toLocaleString()} not-applicable, ${stats.skippedOldDeletion.toLocaleString()} deleted before ${since})`,
    );
  }

  let totalMue = 0;
  for (const version of ['practitioner', 'hospital'] as NcciVersion[]) {
    const file = values[`mue-${version}`];
    if (!file) continue;
    if (!dryRun) await MueLimitModel.deleteMany({ version });
    const count = await writeBatches(streamMueLimits(file, version, dataVersion), insertMany(MueLimitModel));
    totalMue += count;
    console.log(`MUE ${version}: ${count.toLocaleString()} limits loaded`);
  }

  console.log(
    `Total: ${totalEdits.toLocaleString()} NCCI edits and ${totalMue.toLocaleString()} MUE limits in ${((Date.now() - started) / 1000).toFixed(1)}s${dryRun ? ' (dry run)' : ''}`,
  );
  if (!dryRun) {
    await Promise.all([NcciEditModel.syncIndexes(), MueLimitModel.syncIndexes()]);
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
