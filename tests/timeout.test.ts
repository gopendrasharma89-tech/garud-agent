import { describe, expect, it } from 'vitest';
import { parseInterval, retry, sleep, TimeoutError, withTimeout } from '../src/utils/timeout.js';

describe('withTimeout', () => {
  it('passes through values from fast promises', async () => {
    const result = await withTimeout(Promise.resolve(42), 100);
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when too slow', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(withTimeout(slow, 20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('aborts the supplied controller on timeout', async () => {
    const ac = new AbortController();
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await withTimeout(slow, 20, ac).catch(() => undefined);
    expect(ac.signal.aborted).toBe(true);
  });

  it('does nothing when ms <= 0', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 0);
    expect(result).toBe('ok');
  });
});

describe('parseInterval', () => {
  it('passes numbers through', () => {
    expect(parseInterval(500)).toBe(500);
    expect(parseInterval(-10)).toBe(0);
  });

  it('parses unit strings', () => {
    expect(parseInterval('1000ms')).toBe(1000);
    expect(parseInterval('5s')).toBe(5000);
    expect(parseInterval('2m')).toBe(120_000);
    expect(parseInterval('3h')).toBe(10_800_000);
    expect(parseInterval('1d')).toBe(86_400_000);
  });

  it('defaults to ms when no unit is given', () => {
    expect(parseInterval('250')).toBe(250);
  });

  it('rejects invalid input', () => {
    expect(() => parseInterval('forever')).toThrow();
  });
});

describe('sleep', () => {
  it('resolves after roughly ms', async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe('retry', () => {
  it('returns the first successful attempt', async () => {
    let attempts = 0;
    const result = await retry(async () => {
      attempts += 1;
      return 'ok';
    }, { attempts: 3, baseMs: 1 });
    expect(result).toBe('ok');
    expect(attempts).toBe(1);
  });

  it('retries up to attempts on failure', async () => {
    let attempts = 0;
    const result = await retry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('flaky');
      return 'ok';
    }, { attempts: 5, baseMs: 1, jitter: false });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws the final error after all attempts fail', async () => {
    let attempts = 0;
    await expect(retry(async () => {
      attempts += 1;
      throw new Error('boom');
    }, { attempts: 2, baseMs: 1, jitter: false })).rejects.toThrow('boom');
    expect(attempts).toBe(2);
  });
});
