import { extractJsonObject } from '../utils/json-extract.js';
import { HeuristicPlanner, PlannerStrategy, SubTask } from './planner.js';

/**
 * LLM-driven task-decomposition planner. Sends the goal (plus the available
 * tool list) to a completion function and expects a strict-JSON step list
 * back. Every model answer is validated and sanitized; on any failure the
 * planner falls back to the rule-based {@link HeuristicPlanner} so `plan.create`
 * keeps working offline and under LLM outages.
 */
export class LlmPlanner implements PlannerStrategy {
  constructor(
    private readonly complete: (prompt: string) => Promise<string>,
    private readonly fallback: PlannerStrategy = new HeuristicPlanner()
  ) {}

  async plan(
    goal: string,
    context: { availableTools?: string[]; maxSteps?: number } = {}
  ): Promise<SubTask[]> {
    const max = Math.max(1, Math.min(20, context.maxSteps ?? 8));
    const tools = context.availableTools ?? [];
    try {
      const raw = await this.complete(buildDecompositionPrompt(goal, tools, max));
      const steps = sanitizeSubTasks(extractJsonObject(raw), { availableTools: tools, maxSteps: max });
      if (steps.length === 0) throw new Error('LLM returned an empty or invalid plan');
      return steps;
    } catch {
      return Promise.resolve(this.fallback.plan(goal, context));
    }
  }
}

/** Build the strict-JSON decomposition prompt for a goal. */
export function buildDecompositionPrompt(goal: string, tools: string[], maxSteps: number): string {
  const toolBlock = tools.length
    ? `Available tools (use only these as toolHints):\n${tools.map((t) => `- ${t}`).join('\n')}`
    : 'No tool list provided; omit toolHints unless obvious.';
  return [
    'You are a task-decomposition planner. Break the goal into ordered sub-tasks.',
    `Respond with ONLY a JSON object of the form:`,
    '{"steps": [{"id": "s1", "description": "...", "toolHints": ["tool.name"], "dependsOn": ["s1"]}]}',
    `Rules: at most ${maxSteps} steps; ids s1..s${maxSteps}; dependsOn may only reference earlier steps;`,
    'toolHints and dependsOn are optional; descriptions must be short imperative sentences.',
    toolBlock,
    `Goal: ${goal}`
  ].join('\n');
}

/**
 * Validate and normalize a model-emitted step list into safe {@link SubTask}s.
 * - accepts `{steps: [...]}` or a bare array
 * - re-assigns sequential ids (s1, s2, …) and drops steps without a description
 * - filters toolHints to the available tool list (when one is provided)
 * - keeps only dependsOn references to *earlier* steps (no cycles, no forward refs)
 * - clamps to `maxSteps`
 */
export function sanitizeSubTasks(
  value: unknown,
  options: { availableTools?: string[]; maxSteps?: number } = {}
): SubTask[] {
  const max = Math.max(1, Math.min(20, options.maxSteps ?? 8));
  const available = new Set(options.availableTools ?? []);
  const rawList = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray((value as { steps?: unknown[] }).steps))
      ? (value as { steps: unknown[] }).steps
      : [];

  const idMap = new Map<string, string>(); // model id -> normalized id
  const steps: SubTask[] = [];
  for (const raw of rawList) {
    if (steps.length >= max) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { id?: unknown; description?: unknown; toolHints?: unknown; dependsOn?: unknown };
    const description = typeof r.description === 'string' ? r.description.trim().slice(0, 500) : '';
    if (!description) continue;
    const id = `s${steps.length + 1}`;
    if (typeof r.id === 'string' && r.id.trim()) idMap.set(r.id.trim(), id);

    const toolHints = Array.isArray(r.toolHints)
      ? [...new Set(r.toolHints.filter((h): h is string => typeof h === 'string' && h.length > 0)
          .filter((h) => available.size === 0 || available.has(h)))].slice(0, 5)
      : [];
    const priorIds = new Set(steps.map((s) => s.id));
    const dependsOn = Array.isArray(r.dependsOn)
      ? [...new Set(r.dependsOn.filter((d): d is string => typeof d === 'string')
          .map((d) => idMap.get(d.trim()) ?? d.trim())
          .filter((d) => priorIds.has(d)))]
      : [];

    const step: SubTask = { id, description };
    if (toolHints.length > 0) step.toolHints = toolHints;
    if (dependsOn.length > 0) step.dependsOn = dependsOn;
    steps.push(step);
  }
  return steps;
}
