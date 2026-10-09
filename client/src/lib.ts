import { useEffect, useRef, useState } from 'react';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (n: number | undefined) => usd.format(n ?? 0);

export const shortDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/** Calls `load` now and every `ms` while `active` is true. */
export function usePolling<T>(load: () => Promise<T>, ms: number, active: (data: T | undefined) => boolean) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadRef.current()
      .then((d) => !cancelled && (setData(d), setError(undefined)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, [tick]);

  const keepGoing = active(data);
  useEffect(() => {
    if (!keepGoing) return;
    const t = setTimeout(() => setTick((n) => n + 1), ms);
    return () => clearTimeout(t);
  }, [keepGoing, ms, tick]);

  return { data, error, refresh: () => setTick((n) => n + 1) };
}

/** The name shown for a bill: the patient's own name for it, else the provider, else the file name. */
export const billTitle = (b: { displayName?: string; providerName?: string; originalFilename?: string }) =>
  b.displayName || b.providerName || b.originalFilename || 'Medical bill';

export const BILL_TYPE_LABEL: Record<string, string> = {
  physician: "Doctor's office bill",
  outpatient: 'Hospital outpatient bill',
  inpatient: 'Hospital inpatient stay',
  uncertain: 'Bill type unclear',
};

export const CHECK_LABEL: Record<string, string> = {
  duplicates: 'Duplicate charges',
  math: 'Math errors',
  unbundling: 'Services billed separately that should be combined',
  unit_limits: 'Implausible quantities',
  pricing: 'Prices compared with Medicare',
  not_received: 'Services you didn’t receive',
  outside_stay: 'Charges outside your stay dates',
  insurance: 'Comparison with your insurance statement',
};

/** "The AI service is busy, so we'll try again automatically at 4:32 PM." when a retry is scheduled. */
export function busyRetryNote(retryAt: string | undefined): string | undefined {
  if (!retryAt) return undefined;
  const at = new Date(retryAt);
  if (at.getTime() < Date.now() - 60_000) return undefined;
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return at.getTime() <= Date.now()
    ? 'The AI service was busy, so we’re trying again now.'
    : `The AI service is busy right now, so we’ll try again automatically at ${time}. You can leave this page and come back.`;
}
