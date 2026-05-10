import type { Logger } from '../types.js';
import { noopLogger } from '../utils/logger.js';

/** Minimal event-bus surface that the hook runner needs. */
export interface BusLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
}

/**
 * Event-driven hook runner (OpenClaw-inspired). Hooks are JS callbacks
 * registered to fire when specific events occur. Errors in a hook are
 * isolated and never propagate to other hooks or the main loop.
 */
export interface HookDefinition {
  name: string;
  event: string;
  /** Optional filter — runs only when this returns true. */
  match?: (payload: unknown) => boolean;
  /** Async or sync handler. Errors are logged but never throw to the caller. */
  handler: (payload: unknown) => unknown | Promise<unknown>;
}

export class HookRunner {
  private readonly hooks = new Map<string, HookDefinition[]>();
  private readonly stats = new Map<string, { fired: number; errors: number }>();

  constructor(private readonly bus: BusLike, private readonly logger: Logger = noopLogger) {}

  register(hook: HookDefinition): void {
    const list = this.hooks.get(hook.event) ?? [];
    list.push(hook);
    this.hooks.set(hook.event, list);
    this.stats.set(hook.name, { fired: 0, errors: 0 });
    // Subscribe lazily once per event.
    if (list.length === 1) {
      this.bus.on(hook.event, (payload: unknown) => {
        void this.fire(hook.event, payload);
      });
    }
  }

  unregister(name: string): boolean {
    let removed = false;
    for (const [event, list] of this.hooks) {
      const next = list.filter((h) => h.name !== name);
      if (next.length !== list.length) {
        if (next.length === 0) this.hooks.delete(event);
        else this.hooks.set(event, next);
        removed = true;
      }
    }
    this.stats.delete(name);
    return removed;
  }

  /** Number of registered hooks across all events. */
  size(): number {
    let n = 0;
    for (const list of this.hooks.values()) n += list.length;
    return n;
  }

  /** Reset stats counters without unregistering hooks. */
  resetStats(): void {
    for (const k of this.stats.keys()) this.stats.set(k, { fired: 0, errors: 0 });
  }

  list(): Array<{ name: string; event: string; fired: number; errors: number }> {
    const out: Array<{ name: string; event: string; fired: number; errors: number }> = [];
    for (const [event, list] of this.hooks) {
      for (const h of list) {
        const s = this.stats.get(h.name) ?? { fired: 0, errors: 0 };
        out.push({ name: h.name, event, fired: s.fired, errors: s.errors });
      }
    }
    return out;
  }

  private async fire(event: string, payload: unknown): Promise<void> {
    const list = this.hooks.get(event) ?? [];
    for (const hook of list) {
      try {
        if (hook.match && !hook.match(payload)) continue;
        const stats = this.stats.get(hook.name)!;
        stats.fired += 1;
        await hook.handler(payload);
      } catch (error) {
        const stats = this.stats.get(hook.name);
        if (stats) stats.errors += 1;
        this.logger.warn('hook error', { name: hook.name, event, error: String(error) });
      }
    }
  }
}
