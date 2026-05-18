import { newRequestId } from '../utils/request-id.js';
import type { Logger } from '../types.js';
import { noopLogger } from '../utils/logger.js';

/**
 * Periodic self-check that emits a heartbeat event with system state.
 * Inspired by OpenClaw's heartbeat which enables proactive behaviour.
 * The heartbeat is intentionally lightweight — it only collects metadata
 * and emits an event; subscribers decide whether to act on it.
 */
export interface HeartbeatSample {
  id: string;
  ts: number;
  uptimeSec: number;
  rssBytes: number;
  heapUsedBytes: number;
  pendingSubAgents: number;
  /** Free-form fields contributed by subscribers/probes. */
  notes: Record<string, unknown>;
}

export type HeartbeatListener = (sample: HeartbeatSample) => void | Promise<void>;
export type HeartbeatProbe = () => Record<string, unknown> | Promise<Record<string, unknown>>;

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<HeartbeatListener>();
  private readonly probes = new Set<HeartbeatProbe>();
  private lastSample: HeartbeatSample | undefined;
  private samples = 0;

  constructor(
    private readonly intervalMs: number = 60_000,
    private readonly pendingSubAgents: () => number = () => 0,
    private readonly logger: Logger = noopLogger
  ) {}

  start(): void {
    if (this.timer) return;
    // Fire immediately so consumers see an initial sample.
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    // Don't block Node from exiting just because the heartbeat is running.
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  on(listener: HeartbeatListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Register a probe that contributes notes to every heartbeat sample. */
  probe(p: HeartbeatProbe): () => void {
    this.probes.add(p);
    return () => this.probes.delete(p);
  }

  /** Force a synchronous heartbeat sample (without scheduling). */
  async beat(): Promise<HeartbeatSample> {
    return this.tick();
  }

  latest(): HeartbeatSample | undefined { return this.lastSample; }
  count(): number { return this.samples; }
  isRunning(): boolean { return this.timer !== undefined; }

  private async tick(): Promise<HeartbeatSample> {
    const mem = typeof process !== 'undefined' && process.memoryUsage
      ? process.memoryUsage()
      : { rss: 0, heapUsed: 0 } as NodeJS.MemoryUsage;
    const notes: Record<string, unknown> = {};
    for (const probe of this.probes) {
      try {
        const data = await probe();
        if (data && typeof data === 'object') Object.assign(notes, data);
      } catch (error) {
        this.logger.warn('heartbeat probe failed', { error: String(error) });
      }
    }
    const sample: HeartbeatSample = {
      id: newRequestId(),
      ts: Date.now(),
      uptimeSec: Math.floor(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      pendingSubAgents: this.pendingSubAgents(),
      notes
    };
    this.lastSample = sample;
    this.samples += 1;
    // Notify all listeners in parallel so a slow listener cannot block others.
    await Promise.allSettled([...this.listeners].map(async (listener) => {
      try { await listener(sample); }
      catch (error) { this.logger.warn('heartbeat listener failed', { error: String(error) }); }
    }));
    return sample;
  }
}
