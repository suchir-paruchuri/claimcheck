import { Agenda } from 'agenda';
import { config } from '../config';

// Agenda stores jobs in MongoDB, so queued work survives restarts and needs no extra service.
export const agenda = new Agenda({
  db: { address: config.mongoUri, collection: 'jobs' },
  processEvery: '2 seconds',
  defaultLockLifetime: 5 * 60 * 1000, // a crashed worker's job is picked up again after 5 minutes
});

export const JOBS = {
  extract: 'extract-bill',
  analyze: 'analyze-bill',
  letter: 'draft-letter',
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

export interface BillJobData {
  billId: string;
  attempt?: number;
}

export async function enqueue(name: JobName, billId: string) {
  await agenda._ready;
  await agenda.now<BillJobData>(name, { billId, attempt: 1 });
}
