import { RateLimitState } from '../types.js';

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  enabled?: boolean;
  /** Auto-prune expired buckets when the key count reaches this. Default 10_000. */
  pruneThreshold?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

/** Simple fixed-window rate limiter keyed by string. */
export class RateLimiter {
  private readonly states = new Map<string, RateLimitState>();
  private nowProvider: () => number = () => Date.now();

  constructor(private readonly options: RateLimiterOptions) {}

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  allow(key: string): RateLimitResult {
    if (this.options.enabled === false) {
      return {
        allowed: true,
        remaining: this.options.maxRequests,
        resetAt: 0,
        limit: this.options.maxRequests
      };
    }
    const now = this.nowProvider();
    const existing = this.states.get(key);
    if (!existing || now - existing.windowStart >= this.options.windowMs) {
      if (!existing && this.states.size >= (this.options.pruneThreshold ?? 10_000)) this.prune();
      this.states.set(key, { windowStart: now, count: 1 });
      return {
        allowed: true,
        remaining: this.options.maxRequests - 1,
        resetAt: now + this.options.windowMs,
        limit: this.options.maxRequests
      };
    }
    if (existing.count >= this.options.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: existing.windowStart + this.options.windowMs,
        limit: this.options.maxRequests
      };
    }
    existing.count += 1;
    return {
      allowed: true,
      remaining: this.options.maxRequests - existing.count,
      resetAt: existing.windowStart + this.options.windowMs,
      limit: this.options.maxRequests
    };
  }

  peek(key: string): RateLimitResult {
    if (this.options.enabled === false) {
      return { allowed: true, remaining: this.options.maxRequests, resetAt: 0, limit: this.options.maxRequests };
    }
    const now = this.nowProvider();
    const existing = this.states.get(key);
    if (!existing || now - existing.windowStart >= this.options.windowMs) {
      return {
        allowed: true,
        remaining: this.options.maxRequests,
        resetAt: now + this.options.windowMs,
        limit: this.options.maxRequests
      };
    }
    return {
      allowed: existing.count < this.options.maxRequests,
      remaining: Math.max(0, this.options.maxRequests - existing.count),
      resetAt: existing.windowStart + this.options.windowMs,
      limit: this.options.maxRequests
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.states.clear();
    else this.states.delete(key);
  }

  /** Remove buckets whose window has fully elapsed. Returns removed count. */
  prune(): number {
    const now = this.nowProvider();
    let removed = 0;
    for (const [key, state] of this.states) {
      if (now - state.windowStart >= this.options.windowMs) {
        this.states.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.states.size;
  }
}
