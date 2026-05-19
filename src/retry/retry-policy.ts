/**
 * Generic retry helper with exponential backoff + jitter. Useful for
 * wrapping flaky tool calls, LLM requests, or network operations.
 */

export interface RetryOptions {
  /** Max attempts including the first call. Default 3. */
  attempts?: number;
  /** Initial backoff in ms. Default 100ms. */
  baseMs?: number;
  /** Backoff multiplier per attempt. Default 2. */
  factor?: number;
  /** Cap on individual delay in ms. Default 5000ms. */
  maxDelayMs?: number;
  /** When true, add up to 50% random jitter. Default true. */
  jitter?: boolean;
  /** Predicate to decide whether an error should be retried. Default: always. */
  retryable?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry; useful for tracing/logging. */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

export interface RetryResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  attempts: number;
  totalDelayMs: number;
}

export async function withRetry<T>(fn: () => Promise<T> | T, opts: RetryOptions = {}): Promise<RetryResult<T>> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = Math.max(0, opts.baseMs ?? 100);
  const factor = opts.factor ?? 2;
  const cap = Math.max(0, opts.maxDelayMs ?? 5_000);
  const jitter = opts.jitter ?? true;
  const retryable = opts.retryable ?? (() => true);

  let lastError: unknown;
  let totalDelayMs = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await fn();
      return { ok: true, value, attempts: attempt, totalDelayMs };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      if (!retryable(error, attempt)) break;
      const exp = Math.min(cap, base * Math.pow(factor, attempt - 1));
      const delay = jitter ? Math.floor(exp * (0.5 + Math.random() * 0.5)) : exp;
      totalDelayMs += delay;
      opts.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  return { ok: false, error: lastError, attempts, totalDelayMs };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Common retry predicate — retry on network-ish errors but not on
 * validation / auth errors. Adjust to taste.
 */
export function retryNetworkErrors(error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return /timeout|econn|enotfound|fetch failed|aborted|network|socket/.test(msg);
}
