import { Agenda } from 'agenda';
import { config } from '../config';

let instance: Agenda | undefined;

/**
 * Agenda stores jobs in MongoDB, so queued work survives restarts and needs no extra service.
 * Created on first use rather than at import time, so importing this module never opens a
 * connection, and a database that is still starting up can't crash the process.
 */
export function getAgenda(): Agenda {
  if (!instance) {
    instance = new Agenda({
      db: { address: config.mongoUri, collection: 'jobs' },
      processEvery: '2 seconds',
      defaultLockLifetime: 5 * 60 * 1000, // a crashed worker's job is picked up again after 5 minutes
    });
    instance.on('error', (err) => console.error('[agenda]', err));
  }
  return instance;
}

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
  const agenda = getAgenda();
  await agenda._ready;
  await agenda.now<BillJobData>(name, { billId, attempt: 1 });
}
