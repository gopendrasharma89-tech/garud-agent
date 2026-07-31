type Handler<T> = (payload: T) => void | Promise<void>;

/**
 * Type-safe event bus with synchronous emit and async error isolation.
 *
 * Emit iterates a snapshot of the handler set, so handlers registered or
 * removed *during* an emit do not affect that emit (previously a handler
 * subscribing to its own event re-entrantly could run — or loop — within
 * the same emit).
 */
export class EventBus<TEvents extends object> {
  private handlers = new Map<keyof TEvents, Set<Handler<unknown>>>();
  private onError?: (event: keyof TEvents, error: unknown) => void;

  setErrorHandler(handler: (event: keyof TEvents, error: unknown) => void): void {
    this.onError = handler;
  }

  on<TKey extends keyof TEvents>(event: TKey, handler: Handler<TEvents[TKey]>): () => void {
    const existing = this.handlers.get(event) ?? new Set<Handler<unknown>>();
    existing.add(handler as Handler<unknown>);
    this.handlers.set(event, existing);
    return () => existing.delete(handler as Handler<unknown>);
  }

  /** Subscribe for a single delivery; the handler auto-unsubscribes after it fires. */
  once<TKey extends keyof TEvents>(event: TKey, handler: Handler<TEvents[TKey]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      return handler(payload);
    });
    return off;
  }

  /**
   * Promise that resolves with the next payload for `event`. If `timeoutMs`
   * is given and no event arrives in time, rejects with a timeout error.
   */
  waitFor<TKey extends keyof TEvents>(event: TKey, timeoutMs?: number): Promise<TEvents[TKey]> {
    return new Promise<TEvents[TKey]>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.on(event, (payload) => {
        if (timer) clearTimeout(timer);
        off();
        resolve(payload);
      });
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`timeout waiting for event: ${String(event)}`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    });
  }

  off<TKey extends keyof TEvents>(event: TKey, handler: Handler<TEvents[TKey]>): void {
    this.handlers.get(event)?.delete(handler as Handler<unknown>);
  }

  emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
    const handlers = this.handlers.get(event);
    if (!handlers || handlers.size === 0) return;
    for (const handler of [...handlers]) {
      if (!handlers.has(handler)) continue; // removed mid-emit
      try {
        const result = handler(payload as never);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).catch((err) => this.onError?.(event, err));
        }
      } catch (error) {
        this.onError?.(event, error);
      }
    }
  }

  listenerCount(event: keyof TEvents): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
