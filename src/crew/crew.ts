/**
 * Multi-agent crew (CrewAI-inspired). A crew is a roster of agent roles
 * that collaborate on a task. The supervisor decides which agent handles
 * the next sub-task; each agent has a name, role description, and a
 * pluggable handler. Crews can run sequentially or hierarchically.
 *
 * Like everything else in Garud, this layer is zero-dependency and
 * deterministic by default; an LLM brain can plug in semantic routing.
 */

export interface CrewMember {
  name: string;
  role: string;
  /** Tools the agent is allowed to invoke (informational; enforcement is via policy). */
  tools?: string[];
  /** Handler receives the task and shared context; returns its contribution. */
  handler: (task: string, ctx: CrewContext) => Promise<string> | string;
}

export interface CrewContext {
  goal: string;
  history: CrewTurn[];
  /** Free-form shared state. */
  state: Record<string, unknown>;
}

export interface CrewTurn {
  agent: string;
  task: string;
  result: string;
  ts: number;
  durationMs: number;
}

export type Supervisor = (ctx: CrewContext, remaining: string[]) => Promise<{ agent: string; task: string } | null> | { agent: string; task: string } | null;

export interface CrewRunResult {
  goal: string;
  turns: CrewTurn[];
  finalAnswer: string;
  durationMs: number;
  status: 'completed' | 'maxTurns' | 'aborted';
}

export class Crew {
  private readonly members = new Map<string, CrewMember>();
  private supervisor: Supervisor | undefined;
  private maxTurns = 16;

  add(member: CrewMember): this {
    if (this.members.has(member.name)) throw new Error(`agent already in crew: ${member.name}`);
    this.members.set(member.name, member);
    return this;
  }

  setSupervisor(s: Supervisor): this { this.supervisor = s; return this; }
  setMaxTurns(n: number): this { this.maxTurns = Math.max(1, Math.min(100, n)); return this; }
  list(): CrewMember[] { return [...this.members.values()]; }
  size(): number { return this.members.size; }

  /**
   * Run the crew sequentially through each member exactly once, OR with a
   * custom supervisor that picks the next agent dynamically.
   */
  async run(goal: string): Promise<CrewRunResult> {
    const ctx: CrewContext = { goal, history: [], state: {} };
    const startedAt = Date.now();
    const queue: string[] = this.supervisor ? [] : [...this.members.keys()];
    let status: CrewRunResult['status'] = 'completed';
    let turns = 0;

    while (turns < this.maxTurns) {
      let next: { agent: string; task: string } | null;
      if (this.supervisor) {
        next = await this.supervisor(ctx, queue);
        if (!next) break;
      } else {
        const agent = queue.shift();
        if (!agent) break;
        next = { agent, task: goal };
      }

      const member = this.members.get(next.agent);
      if (!member) {
        ctx.history.push({ agent: next.agent, task: next.task, result: `unknown agent ${next.agent}`, ts: Date.now(), durationMs: 0 });
        turns += 1;
        continue;
      }
      const t0 = Date.now();
      let result: string;
      try {
        result = await member.handler(next.task, ctx);
      } catch (error) {
        result = `agent error: ${error instanceof Error ? error.message : String(error)}`;
      }
      ctx.history.push({ agent: next.agent, task: next.task, result, ts: t0, durationMs: Date.now() - t0 });
      turns += 1;
    }
    if (turns >= this.maxTurns) status = 'maxTurns';

    // Final answer = concatenation of all agent results separated by a blank line.
    const finalAnswer = ctx.history.map((t) => `### ${t.agent}\n${t.result}`).join('\n\n');
    return { goal, turns: ctx.history, finalAnswer, durationMs: Date.now() - startedAt, status };
  }
}

/** Simple round-robin supervisor that cycles through members until queue empties. */
export function roundRobinSupervisor(crew: Crew): Supervisor {
  const names = crew.list().map((m) => m.name);
  let i = 0;
  return (ctx) => {
    if (i >= names.length) return null;
    const agent = names[i++];
    return agent ? { agent, task: ctx.goal } : null;
  };
}
