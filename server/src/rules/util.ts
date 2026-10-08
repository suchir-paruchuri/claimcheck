import type { CheckId, Finding } from '../domain/types';

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Builds findings with stable, readable IDs like "duplicates-1". */
export function findingFactory(checkId: CheckId) {
  let n = 0;
  return (f: Omit<Finding, 'id' | 'checkId'>): Finding => ({
    ...f,
    id: `${checkId}-${++n}`,
    checkId,
    amount: round2(f.amount),
  });
}

export const money = (n: number) => `$${round2(n).toFixed(2)}`;
