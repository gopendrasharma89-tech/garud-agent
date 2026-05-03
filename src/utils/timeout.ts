/**
 * Wrap a promise with a timeout. If the promise does not resolve within `ms`,
 * it rejects with a TimeoutError. The provided abort controller (if any) will
 * also be aborted to give the operation a chance to clean up.
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  controller?: AbortController
): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new TimeoutError(`Operation timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return (await Promise.race([promise, timeoutPromise])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Parse a human-friendly interval like "5s", "30m", "2h", or a raw ms number. */
export function parseInterval(value: string | number): number {
  if (typeof value === 'number') return Math.max(0, value);
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid interval: ${value}`);
  const n = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: throw new Error(`Invalid interval unit: ${unit}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry an operation with exponential backoff and optional jitter. */
export async function retry<T>(
  op: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; maxMs?: number; jitter?: boolean } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseMs = Math.max(1, options.baseMs ?? 100);
  const maxMs = Math.max(baseMs, options.maxMs ?? 5000);
  const jitter = options.jitter ?? true;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      const delay = Math.min(maxMs, baseMs * Math.pow(2, i));
      const wait = jitter ? Math.floor(delay * (0.5 + Math.random() * 0.5)) : delay;
      await sleep(wait);
    }
  }
  throw lastError;
}
