import { newRequestId } from '../utils/request-id.js';
import type { AgentRuntime } from '../agent/agent-runtime.js';
import type { Logger, Session } from '../types.js';
import { noopLogger } from '../utils/logger.js';

/**
 * Sub-agent runner (OpenClaw-inspired). Runs an isolated background turn
 * without blocking the main conversation. Sub-agents cannot nest — any
 * attempt by a sub-agent to spawn another sub-agent is rejected.
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
  private active = 0;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly maxConcurrent = 4,
    private readonly logger: Logger = noopLogger
  ) {}

  /** Spawn a background sub-agent. Returns the job id immediately. */
  spawn(task: string, parentSession: Session): { jobId: string; accepted: boolean; reason?: string } {
    if ((parentSession as Session & { settings: { isSubAgent?: boolean } }).settings.isSubAgent) {
      return { jobId: '', accepted: false, reason: 'sub-agents cannot nest' };
    }
    if (this.active >= this.maxConcurrent) {
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
    this.active += 1;
    job.status = 'running';
    try {
      const subSession: Session = {
        ...parent,
        id: `${parent.id}::sub::${job.id.slice(0, 8)}`,
        role: 'automation',
        settings: { ...parent.settings, isSubAgent: true, parentSessionId: parent.id }
      };
      const reply = await this.runtime.reply(subSession, job.task, undefined, job.id);
      job.result = reply.text;
      job.status = 'done';
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = Date.now();
      this.active -= 1;
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

  /** Best-effort cancel — marks pending jobs as failed. Running jobs continue. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'pending') {
      job.status = 'failed';
      job.error = 'cancelled';
      job.finishedAt = Date.now();
      return true;
    }
    return false;
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
