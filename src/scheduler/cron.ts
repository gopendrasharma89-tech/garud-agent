import { CronJobConfig, Logger } from '../types.js';
import { noopLogger } from '../utils/logger.js';
import { parseInterval } from '../utils/timeout.js';

interface RunningJob {
  config: CronJobConfig;
  intervalMs: number;
  timer?: ReturnType<typeof setInterval>;
  lastRunAt?: number;
  runCount: number;
  errorCount: number;
  inFlight: boolean;
}

/**
 * Lightweight scheduler. Each job runs on a fixed-interval timer; ticks that
 * fire while a previous invocation is still running are skipped (no overlap).
 * `runNow()` also respects the inFlight guard.
 */
export class CronScheduler {
  private readonly jobs = new Map<string, RunningJob>();
  private readonly logger: Logger;
  private running = false;

  constructor(logger: Logger = noopLogger) {
    this.logger = logger.child('cron');
  }

  add(config: CronJobConfig): void {
    if (this.jobs.has(config.id)) {
      throw new Error(`Cron job already registered: ${config.id}`);
    }
    const intervalMs = parseInterval(config.interval);
    if (intervalMs <= 0) {
      throw new Error(`Cron interval must be positive: ${config.id}`);
    }
    this.jobs.set(config.id, {
      config,
      intervalMs,
      runCount: 0,
      errorCount: 0,
      inFlight: false
    });
    if (this.running && (config.enabled ?? true)) {
      this.startJob(this.jobs.get(config.id)!);
    }
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.timer) clearInterval(job.timer);
    this.jobs.delete(id);
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const job of this.jobs.values()) {
      if (job.config.enabled === false) continue;
      this.startJob(job);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const job of this.jobs.values()) {
      if (job.timer) clearInterval(job.timer);
      job.timer = undefined;
    }
  }

  /** Force a one-off invocation. Skips when a run is already in flight. */
  async runNow(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Cron job not found: ${id}`);
    if (job.inFlight) return false;
    await this.invoke(job);
    return true;
  }

  list(): Array<{
    id: string;
    intervalMs: number;
    runCount: number;
    errorCount: number;
    lastRunAt?: number;
    enabled: boolean;
    inFlight: boolean;
  }> {
    return [...this.jobs.values()].map((j) => ({
      id: j.config.id,
      intervalMs: j.intervalMs,
      runCount: j.runCount,
      errorCount: j.errorCount,
      lastRunAt: j.lastRunAt,
      enabled: j.config.enabled !== false,
      inFlight: j.inFlight
    }));
  }

  private startJob(job: RunningJob): void {
    if (job.timer) return;
    job.timer = setInterval(() => {
      void this.invoke(job);
    }, job.intervalMs);
    job.timer.unref?.();
    if (job.config.runOnStart && job.runCount === 0) {
      void this.invoke(job);
    }
  }

  private async invoke(job: RunningJob): Promise<void> {
    if (job.inFlight) return;
    job.inFlight = true;
    const now = Date.now();
    job.lastRunAt = now;
    job.runCount += 1;
    try {
      await job.config.task({ now, log: this.logger });
    } catch (error) {
      job.errorCount += 1;
      this.logger.warn('cron job failed', {
        id: job.config.id,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      job.inFlight = false;
    }
  }
}
