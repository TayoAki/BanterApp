import type { JobStatusDto } from '@marshmemos/contracts/api';
import { AppState } from 'react-native';
import { api } from './api';

export type PollOutcome =
  | { kind: 'succeeded'; job: JobStatusDto }
  | { kind: 'failed'; job: JobStatusDto }
  | { kind: 'canceled'; job: JobStatusDto }
  | { kind: 'still_working'; job: JobStatusDto | null }
  | { kind: 'aborted' };

/** Interactive waiting budget before offering "We’re still working" (ms). */
export const STILL_WORKING_AFTER_MS = 120_000;

/**
 * Polls an owned job with increasing intervals (about 1s, 2s, then 4s),
 * pausing while the app is in the background. A client timeout does not
 * imply the server job stopped: the caller keeps a recoverable pending item.
 */
export async function pollJob(jobId: string, options: { signal?: AbortSignal; onUpdate?: (job: JobStatusDto) => void; maxWaitMs?: number } = {}): Promise<PollOutcome> {
  const started = Date.now();
  const delays = [1000, 2000, 4000];
  let i = 0;
  let last: JobStatusDto | null = null;
  const maxWait = options.maxWaitMs ?? STILL_WORKING_AFTER_MS;
  while (!options.signal?.aborted) {
    if (AppState.currentState === 'active') {
      try {
        last = await api.job(jobId);
        options.onUpdate?.(last);
        if (last.state === 'succeeded') return { kind: 'succeeded', job: last };
        if (last.state === 'failed') return { kind: 'failed', job: last };
        if (last.state === 'canceled') return { kind: 'canceled', job: last };
      } catch {
        // Network hiccups are not job failures; keep polling within budget.
      }
    }
    if (Date.now() - started > maxWait) return { kind: 'still_working', job: last };
    await sleep(delays[Math.min(i, delays.length - 1)]!, options.signal);
    i += 1;
  }
  return { kind: 'aborted' };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
