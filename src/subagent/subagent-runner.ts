import { newRequestId } from '../utils/request-id.js';
import type { AgentRuntime } from '../agent/agent-runtime.js';
import type { Logger, Session } from '../types.js';
import { noopLogger } from '../utils/logger.js';

/**
 * Sub-agent runner (OpenClaw-inspired). Runs an isolated background turn
 * without blocking the main conversation. Sub-agents cannot nest — any
 * attempt by a sub-agent to spawn another sub-agent is rejected.
 *
 * Each job carries its own AbortController, so `cancel()` interrupts
 * *running* jobs too (the runtime honours the signal), not just pending
 * ones. Settled jobs older than `retentionMs` are pruned automatically on
 * every spawn to bound memory in long-running gateways.
 */
export interface SubAgentJob {
  id: string;
  task: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

export class SubAgentRunner {
  private readonly jobs = new Map<string, SubAgentJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelRequested = new Set<string>();
  private activeCount = 0;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly maxConcurrent = 4,
    private readonly logger: Logger = noopLogger,
    private readonly retentionMs = 3600_000
  ) {}

  /** Spawn a background sub-agent. Returns the job id immediately. */
  spawn(task: string, parentSession: Session): { jobId: string; accepted: boolean; reason?: string } {
    this.prune(this.retentionMs);
    if ((parentSession as Session & { settings: { isSubAgent?: boolean } }).settings.isSubAgent) {
      return { jobId: '', accepted: false, reason: 'sub-agents cannot nest' };
    }
    if (this.activeCount >= this.maxConcurrent) {
      return { jobId: '', accepted: false, reason: 'max concurrent sub-agents reached' };
    }
    const job: SubAgentJob = {
      id: newRequestId(),
      task,
      status: 'pending',
      startedAt: Date.now()
    };
    this.jobs.set(job.id, job);
    this.runJob(job, parentSession).catch((err) => {
      this.logger.error('subagent failure', { id: job.id, err: String(err) });
    });
    return { jobId: job.id, accepted: true };
  }

  private async runJob(job: SubAgentJob, parent: Session): Promise<void> {
    this.activeCount += 1;
    job.status = 'running';
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const subSession: Session = {
        ...parent,
        id: `${parent.id}::sub::${job.id.slice(0, 8)}`,
        role: 'automation',
        settings: { ...parent.settings, isSubAgent: true, parentSessionId: parent.id }
      };
      const reply = await this.runtime.reply(subSession, job.task, controller.signal, job.id);
      if (this.cancelRequested.has(job.id)) {
        job.status = 'failed';
        job.error = 'cancelled';
      } else {
        job.result = reply.text;
        job.status = 'done';
      }
    } catch (error) {
      job.status = 'failed';
      job.error = this.cancelRequested.has(job.id)
        ? 'cancelled'
        : error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = Date.now();
      this.activeCount -= 1;
      this.controllers.delete(job.id);
      this.cancelRequested.delete(job.id);
    }
  }

  get(id: string): SubAgentJob | undefined { return this.jobs.get(id); }

  list(limit = Infinity): SubAgentJob[] {
    const sorted = [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
  }

  pending(): number { return [...this.jobs.values()].filter((j) => j.status === 'pending' || j.status === 'running').length; }

  /** Wait for a job to settle (done or failed) up to timeoutMs. */
  async wait(jobId: string, timeoutMs = 30_000): Promise<SubAgentJob> {
    const start = Date.now();
    while (true) {
      const job = this.jobs.get(jobId);
      if (!job) throw new Error('job not found');
      if (job.status === 'done' || job.status === 'failed') return job;
      if (Date.now() - start > timeoutMs) throw new Error('wait timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Cancel a job. Pending jobs are settled immediately; running jobs are
   * aborted via their AbortSignal (the runtime stops at the next checkpoint)
   * and settle as `failed` with error `cancelled`. Returns false if the job
   * is missing or already settled.
   */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'pending') {
      job.status = 'failed';
      job.error = 'cancelled';
      job.finishedAt = Date.now();
      return true;
    }
    if (job.status === 'running') {
      const controller = this.controllers.get(jobId);
      if (!controller) return false;
      this.cancelRequested.add(jobId);
      controller.abort();
      return true;
    }
    return false;
  }

  /** Currently running jobs. */
  active(): SubAgentJob[] {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.status === 'pending');
  }

  /** Runtime in ms for a job. Returns -1 if missing, 0 if pending. */
  jobDuration(id: string): number {
    const job = this.jobs.get(id);
    if (!job) return -1;
    if (job.status === 'pending') return 0;
    const end = job.finishedAt ?? Date.now();
    return Math.max(0, end - job.startedAt);
  }

  /** Counters keyed by status. */
  stats(): { pending: number; running: number; done: number; failed: number; total: number } {
    const s = { pending: 0, running: 0, done: 0, failed: 0, total: 0 };
    for (const job of this.jobs.values()) {
      s[job.status] += 1;
      s.total += 1;
    }
    return s;
  }

  /** Drop completed jobs older than `olderThanMs` to bound memory. */
  prune(olderThanMs = 3600_000): number {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if ((job.status === 'done' || job.status === 'failed') && (job.finishedAt ?? 0) < cutoff) {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
