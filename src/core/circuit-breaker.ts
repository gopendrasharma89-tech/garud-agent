export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Lightweight circuit breaker. After `failureThreshold` consecutive failures
 * the circuit opens; after `cooldownMs` it lets one probe through (half-open),
 * which either closes (on success) or re-opens (on failure).
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private nowProvider: () => number = () => Date.now();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 30_000);
  }

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  allowRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.nowProvider() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        this.probeInFlight = true;
        return true;
      }
      return false;
    }
    // Half-open: admit exactly one probe at a time. Concurrent callers are
    // rejected until the in-flight probe reports success or failure.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.probeInFlight = false;
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.probeInFlight = false;
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = this.nowProvider();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.nowProvider();
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailures(): number {
    return this.failures;
  }
}
