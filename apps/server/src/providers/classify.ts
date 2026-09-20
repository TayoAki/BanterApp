import { ProviderError } from './types.js';

/**
 * Maps SDK/HTTP failures from any provider (OpenAI SDK, OpenRouter through the
 * OpenAI SDK, Google GenAI SDK) to the worker's ProviderError kinds. Messages
 * carry status and class only, never request or response payloads.
 */
export function classifyProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const anyErr = err as { status?: number; code?: string; message?: string; headers?: Record<string, string> | Headers; name?: string } | null;
  const message = anyErr?.message ?? String(err);
  if (anyErr?.name === 'AbortError' || anyErr?.name === 'APIConnectionTimeoutError' || /timed? ?out|deadline/i.test(message)) {
    return new ProviderError('timeout', 'Provider timeout.', { billingUncertain: true });
  }
  const status = anyErr?.status;
  if (status === 429) {
    let retryAfterMs: number | null = null;
    const h = anyErr?.headers;
    const ra = h instanceof Headers ? h.get('retry-after') : h?.['retry-after'];
    if (ra && Number.isFinite(Number(ra))) retryAfterMs = Number(ra) * 1000;
    return new ProviderError('rate_limited', 'Provider rate limit.', { retryAfterMs });
  }
  if (status === 401 || status === 403 || status === 402) return new ProviderError('denied', `Provider access denied (${status}).`);
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) return new ProviderError('bad_input', `Provider rejected input (${status}).`);
  if (status !== undefined && status >= 500) return new ProviderError('transient', `Provider error ${status}.`, { billingUncertain: true });
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|fetch failed|network|socket/i.test(message)) return new ProviderError('transient', 'Network error reaching provider.', { billingUncertain: true });
  return new ProviderError('transient', 'Provider call failed.', { billingUncertain: true });
}
