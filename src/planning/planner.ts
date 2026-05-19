/**
 * Task-decomposition planner. Given a high-level goal, produce an ordered
 * list of sub-tasks with optional tool hints. The default planner is
 * heuristic (rule-based) so it works without a network call; an LLM
 * planner can be plugged in via the `PlannerStrategy` interface.
 */

export interface SubTask {
  id: string;
  description: string;
  /** Optional tool hint — names of tools the agent might use for this step. */
  toolHints?: string[];
  /** Optional dependency ids (subtask must run after these). */
  dependsOn?: string[];
}

export interface Plan {
  goal: string;
  steps: SubTask[];
  createdAt: number;
}

export interface PlannerStrategy {
  plan(goal: string, context?: { availableTools?: string[]; maxSteps?: number }): Promise<SubTask[]> | SubTask[];
}

/** Heuristic planner — splits on common cue words and infers tool hints. */
export class HeuristicPlanner implements PlannerStrategy {
  plan(goal: string, context: { availableTools?: string[]; maxSteps?: number } = {}): SubTask[] {
    const max = Math.max(1, Math.min(20, context.maxSteps ?? 8));
    const tools = context.availableTools ?? [];

    // Split goal into clauses on "and then", "next", "after that", commas, semicolons.
    const cleaned = goal.trim().replace(/\s+/g, ' ');
    const parts = cleaned
      .split(/\b(?:and then|then|next|after that|finally|first|second|lastly)\b|[;]/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 2)
      .slice(0, max);

    if (parts.length === 0) parts.push(cleaned);

    return parts.map((description, i) => {
      const id = `s${i + 1}`;
      const toolHints = inferTools(description, tools);
      const dependsOn = i > 0 ? [`s${i}`] : undefined;
      return toolHints.length > 0
        ? (dependsOn ? { id, description, toolHints, dependsOn } : { id, description, toolHints })
        : (dependsOn ? { id, description, dependsOn } : { id, description });
    });
  }
}

function inferTools(description: string, available: string[]): string[] {
  const lower = description.toLowerCase();
  const cues: Array<[RegExp, string]> = [
    [/\b(remember|note|save)\b/, 'memory.save'],
    [/\b(forget|delete memory)\b/, 'memory.forget'],
    [/\b(recall|what did|previously)\b/, 'memory.search'],
    [/\b(time|now|date)\b/, 'time.now'],
    [/\b(calculate|compute|math|sum|average)\b/, 'math.eval'],
    [/\b(fetch|http|download|url)\b/, 'http.fetch'],
    [/\b(parse json|json)\b/, 'json.parse'],
    [/\b(uuid|guid)\b/, 'random.uuid'],
    [/\b(hash|sha)\b/, 'hash.sha256'],
    [/\b(encode|base64)\b/, 'base64.encode']
  ];
  const hits = new Set<string>();
  for (const [re, tool] of cues) {
    if (re.test(lower) && (available.length === 0 || available.includes(tool))) hits.add(tool);
  }
  return [...hits];
}

export function buildPlan(goal: string, strategy: PlannerStrategy = new HeuristicPlanner(), context?: { availableTools?: string[]; maxSteps?: number }): Promise<Plan> {
  return Promise.resolve(strategy.plan(goal, context)).then((steps) => ({
    goal,
    steps: Array.isArray(steps) ? steps : [],
    createdAt: Date.now()
  }));
}
