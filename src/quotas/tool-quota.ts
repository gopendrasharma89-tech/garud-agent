interface BucketState {
  count: number;
  windowStart: number;
}

export interface ToolQuotaOptions {
  /** Default per-(session, tool) limit per windowMs. 0 disables. */
  defaultLimit?: number;
  /** Window size for quota counting; defaults to 24h. */
  windowMs?: number;
}

export interface ToolQuotaResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

/**
 * Per-(session, tool) usage quotas, counted over a rolling fixed window.
 * Tools may also declare their own `dailyQuota` which overrides the default.
 */
export class ToolQuotaManager {
  private readonly buckets = new Map<string, BucketState>();
  private readonly toolLimits = new Map<string, number>();
  private nowProvider: () => number = () => Date.now();

  constructor(private readonly options: ToolQuotaOptions = {}) {}

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  setToolLimit(toolName: string, limit: number | undefined): void {
    if (limit === undefined || limit <= 0) {
      this.toolLimits.delete(toolName);
    } else {
      this.toolLimits.set(toolName, limit);
    }
  }

  private limitFor(toolName: string): number {
    const explicit = this.toolLimits.get(toolName);
    if (explicit !== undefined) return explicit;
    return this.options.defaultLimit ?? 0;
  }

  private windowMs(): number {
    return this.options.windowMs ?? 24 * 3600_000;
  }

  private key(sessionId: string, toolName: string): string {
    return `${sessionId}::${toolName}`;
  }

  /** Consume a quota slot. Returns whether the call is allowed. */
  consume(sessionId: string, toolName: string): ToolQuotaResult {
    const limit = this.limitFor(toolName);
    if (limit <= 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAt: 0, limit: 0 };
    }
    const now = this.nowProvider();
    const window = this.windowMs();
    const key = this.key(sessionId, toolName);
    const existing = this.buckets.get(key);
    if (!existing || now - existing.windowStart >= window) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, remaining: limit - 1, resetAt: now + window, limit };
    }
    if (existing.count >= limit) {
      return { allowed: false, remaining: 0, resetAt: existing.windowStart + window, limit };
    }
    existing.count += 1;
    return {
      allowed: true,
      remaining: limit - existing.count,
      resetAt: existing.windowStart + window,
      limit
    };
  }

  /** Inspect quota without consuming. */
  peek(sessionId: string, toolName: string): ToolQuotaResult {
    const limit = this.limitFor(toolName);
    if (limit <= 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAt: 0, limit: 0 };
    }
    const now = this.nowProvider();
    const window = this.windowMs();
    const existing = this.buckets.get(this.key(sessionId, toolName));
    if (!existing || now - existing.windowStart >= window) {
      return { allowed: true, remaining: limit, resetAt: now + window, limit };
    }
    return {
      allowed: existing.count < limit,
      remaining: Math.max(0, limit - existing.count),
      resetAt: existing.windowStart + window,
      limit
    };
  }

  reset(sessionId?: string, toolName?: string): void {
    if (!sessionId && !toolName) {
      this.buckets.clear();
      return;
    }
    for (const key of [...this.buckets.keys()]) {
      const [keySession, keyTool] = key.split('::');
      if (sessionId && keySession !== sessionId) continue;
      if (toolName && keyTool !== toolName) continue;
      this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}
