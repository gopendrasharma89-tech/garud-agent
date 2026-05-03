type Handler<T> = (payload: T) => void | Promise<void>;

/**
 * Type-safe event bus with synchronous emit and async error isolation.
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

  off<TKey extends keyof TEvents>(event: TKey, handler: Handler<TEvents[TKey]>): void {
    this.handlers.get(event)?.delete(handler as Handler<unknown>);
  }

  emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
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
