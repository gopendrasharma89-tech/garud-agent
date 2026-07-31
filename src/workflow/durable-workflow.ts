import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Durable workflow runner. Each step's input/output is appended to a JSONL
 * checkpoint file; on restart the workflow resumes from the last completed
 * step rather than re-running everything.
 *
 * This is intentionally simpler than LangGraph/Temporal: no DAG, just an
 * ordered list of named steps. Good for "fetch -> transform -> persist"
 * style flows that need to survive crashes / restarts.
 *
 * Disk layout:
 *   workspace/workflows/<id>.jsonl
 *
 * Each line is one event:
 *   {"t":"start","ts":...,"input":...}
 *   {"t":"step","name":"fetch","ts":...,"output":...}
 *   {"t":"step","name":"transform","ts":...,"output":...}
 *   {"t":"done","ts":...,"final":...}
 *   {"t":"error","ts":...,"step":"fetch","error":"..."}
 *
 * On resume, completed step outputs are loaded back into the state and
 * remaining steps execute. If a step fails, the workflow halts with an
 * `error` event \u2014 the caller can fix the bug and re-run; the prior
 * successful steps are skipped.
 */

export type WorkflowStep<TState> = {
  name: string;
  run: (state: TState) => Promise<Partial<TState> | void> | Partial<TState> | void;
  /** Retry the step this many times (max 10) before recording an error event. */
  retries?: number;
  /** Delay between retry attempts, in ms. */
  retryDelayMs?: number;
};

export interface WorkflowRunResult<TState> {
  id: string;
  status: 'completed' | 'failed' | 'resumed-completed' | 'resumed-failed';
  state: TState;
  completedSteps: string[];
  failedStep?: string;
  error?: string;
  durationMs: number;
}

export interface WorkflowEvent {
  t: 'start' | 'step' | 'done' | 'error';
  ts: number;
  name?: string;
  output?: unknown;
  input?: unknown;
  final?: unknown;
  step?: string;
  error?: string;
}

export class DurableWorkflowRunner {
  constructor(private readonly dir: string) {}

  /** Inspect a workflow log without running anything. */
  async inspect(id: string): Promise<{ events: WorkflowEvent[]; completedSteps: string[]; lastEventTs: number }> {
    const events = await this.readLog(id);
    const completedSteps = events.filter((e) => e.t === 'step' && typeof e.name === 'string').map((e) => e.name!);
    const lastEventTs = events.length === 0 ? 0 : events[events.length - 1]!.ts;
    return { events, completedSteps, lastEventTs };
  }

  /** Run a workflow, resuming from prior checkpoints if any. */
  async run<TState>(id: string, initialState: TState, steps: WorkflowStep<TState>[]): Promise<WorkflowRunResult<TState>> {
    const t0 = Date.now();
    const safe = sanitiseId(id);
    if (!safe) return { id: '', status: 'failed', state: initialState, completedSteps: [], error: 'invalid workflow id', durationMs: 0 };
    const dup = findDuplicateStepName(steps);
    if (dup) return { id: safe, status: 'failed', state: initialState, completedSteps: [], error: `duplicate step name: ${dup}`, durationMs: Date.now() - t0 };
    await fs.mkdir(this.dir, { recursive: true });
    const logPath = path.join(this.dir, `${safe}.jsonl`);

    const prior = await this.readLog(safe);
    const resumed = prior.length > 0;
    const completedNames = new Set<string>();
    let state: TState = initialState;
    for (const e of prior) {
      if (e.t === 'step' && typeof e.name === 'string') {
        completedNames.add(e.name);
        if (e.output && typeof e.output === 'object') Object.assign(state as object, e.output);
      }
      if (e.t === 'done') {
        // Already finished; surface the prior final state.
        return { id: safe, status: 'resumed-completed', state, completedSteps: [...completedNames], durationMs: Date.now() - t0 };
      }
    }
    if (!resumed) await this.append(logPath, { t: 'start', ts: Date.now(), input: initialState as unknown });

    const completedSteps: string[] = [...completedNames];
    for (const step of steps) {
      if (completedNames.has(step.name)) continue;
      try {
        const patch = await execStepWithRetries(step, state);
        if (patch && typeof patch === 'object') Object.assign(state as object, patch);
        await this.append(logPath, { t: 'step', ts: Date.now(), name: step.name, output: patch ?? null });
        completedSteps.push(step.name);
      } catch (e) {
        const err = (e as Error).message;
        await this.append(logPath, { t: 'error', ts: Date.now(), step: step.name, error: err });
        return { id: safe, status: resumed ? 'resumed-failed' : 'failed', state, completedSteps, failedStep: step.name, error: err, durationMs: Date.now() - t0 };
      }
    }
    await this.append(logPath, { t: 'done', ts: Date.now(), final: state as unknown });
    return { id: safe, status: resumed ? 'resumed-completed' : 'completed', state, completedSteps, durationMs: Date.now() - t0 };
  }

  /** Delete a workflow log (start fresh next run). */
  async reset(id: string): Promise<boolean> {
    const safe = sanitiseId(id);
    if (!safe) return false;
    try { await fs.unlink(path.join(this.dir, `${safe}.jsonl`)); return true; }
    catch { return false; }
  }

  /** List workflow ids on disk. */
  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries.filter((e) => e.endsWith('.jsonl')).map((e) => e.slice(0, -6)).sort();
    } catch { return []; }
  }

  private async append(file: string, event: WorkflowEvent): Promise<void> {
    await fs.appendFile(file, JSON.stringify(event) + '\n', 'utf8');
  }

  private async readLog(id: string): Promise<WorkflowEvent[]> {
    const safe = sanitiseId(id);
    if (!safe) return [];
    let body: string;
    try { body = await fs.readFile(path.join(this.dir, `${safe}.jsonl`), 'utf8'); }
    catch { return []; }
    const out: WorkflowEvent[] = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as WorkflowEvent); }
      catch { /* skip malformed */ }
    }
    return out;
  }
}

function findDuplicateStepName<TState>(steps: WorkflowStep<TState>[]): string | null {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.name)) return step.name;
    seen.add(step.name);
  }
  return null;
}

async function execStepWithRetries<TState>(step: WorkflowStep<TState>, state: TState): Promise<Partial<TState> | void> {
  const attempts = Math.max(0, Math.min(10, Math.floor(step.retries ?? 0))) + 1;
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await Promise.resolve(step.run(state));
    } catch (error) {
      lastError = error;
      const delay = step.retryDelayMs ?? 0;
      if (i < attempts - 1 && delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function sanitiseId(id: string): string {
  return (id ?? '').toString().toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}
