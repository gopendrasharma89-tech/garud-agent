import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/core/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to maxRequests in a window', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });
    limiter.setTimeProvider(() => now);
    expect(limiter.allow('k').allowed).toBe(true);
    expect(limiter.allow('k').allowed).toBe(true);
    expect(limiter.allow('k').allowed).toBe(true);
    expect(limiter.allow('k').allowed).toBe(false);
  });

  it('resets after the window elapses', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.setTimeProvider(() => now);
    expect(limiter.allow('k').allowed).toBe(true);
    expect(limiter.allow('k').allowed).toBe(false);
    now += 1500;
    expect(limiter.allow('k').allowed).toBe(true);
  });

  it('isolates keys', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(limiter.allow('a').allowed).toBe(true);
    expect(limiter.allow('b').allowed).toBe(true);
    expect(limiter.allow('a').allowed).toBe(false);
  });

  it('respects enabled=false', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1, enabled: false });
    expect(limiter.allow('k').allowed).toBe(true);
    expect(limiter.allow('k').allowed).toBe(true);
  });

  it('reports remaining and resetAt', () => {
    let now = 1000;
    const limiter = new RateLimiter({ windowMs: 500, maxRequests: 2 });
    limiter.setTimeProvider(() => now);
    const r1 = limiter.allow('k');
    expect(r1.remaining).toBe(1);
    expect(r1.resetAt).toBe(1500);
    expect(r1.limit).toBe(2);
  });

  it('reset clears state', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(limiter.allow('k').allowed).toBe(true);
    expect(limiter.allow('k').allowed).toBe(false);
    limiter.reset('k');
    expect(limiter.allow('k').allowed).toBe(true);
  });

  it('reset() with no key clears everything', () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.allow('a');
    limiter.allow('b');
    expect(limiter.size()).toBe(2);
    limiter.reset();
    expect(limiter.size()).toBe(0);
  });
});
