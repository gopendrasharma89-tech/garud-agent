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

  list(): SubAgentJob[] { return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt); }

  pending(): number { return [...this.jobs.values()].filter((j) => j.status === 'pending' || j.status === 'running').length; }

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
