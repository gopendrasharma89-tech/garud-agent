import { AgentGraph, END, type GraphNodeFn } from './agent-graph.js';

/**
 * Built-in graph templates for common agent patterns. These are LangGraph-style
 * shapes pre-wired with sensible defaults — bring your own node functions.
 */

/**
 * ReAct loop: think → act → observe → think → ... until done.
 *
 * State must include a boolean `done` (or thinker can return `done: true`)
 * to terminate. Loops are bounded by `maxSteps` at run-time.
 */
export interface ReactState {
  done?: boolean;
  thoughts?: string[];
  actions?: string[];
  observations?: string[];
}

export function reactGraph<TState extends ReactState>(nodes: {
  think: GraphNodeFn<TState>;
  act: GraphNodeFn<TState>;
  observe: GraphNodeFn<TState>;
}): AgentGraph<TState> {
  return new AgentGraph<TState>()
    .addNode('think', nodes.think)
    .addNode('act', nodes.act)
    .addNode('observe', nodes.observe)
    .addEdge('think', END, (ctx) => Boolean(ctx.state.done))
    .addEdge('think', 'act')
    .addEdge('act', 'observe')
    .addEdge('observe', 'think')
    .setEntry('think');
}

/**
 * Supervisor pattern: a central supervisor node routes to one of several
 * worker nodes based on its decision. After a worker finishes, control
 * returns to the supervisor which decides whether to continue or stop.
 *
 * State must include a `nextWorker` field (string or null) — set by the
 * supervisor — to direct the next hop.
 */
export interface SupervisorState {
  nextWorker?: string | null;
  results?: Array<{ worker: string; output: unknown }>;
}

export function supervisorGraph<TState extends SupervisorState>(
  supervisor: GraphNodeFn<TState>,
  workers: Record<string, GraphNodeFn<TState>>
): AgentGraph<TState> {
  const graph = new AgentGraph<TState>().addNode('supervisor', supervisor);
  for (const [name, fn] of Object.entries(workers)) {
    graph.addNode(name, fn);
    graph.addEdge(name, 'supervisor');
  }
  // Conditional edges from supervisor: pick the worker named in nextWorker, or END if null.
  graph.addEdge('supervisor', END, (ctx) => !ctx.state.nextWorker);
  for (const name of Object.keys(workers)) {
    graph.addEdge('supervisor', name, (ctx) => ctx.state.nextWorker === name);
  }
  graph.setEntry('supervisor');
  return graph;
}

/**
 * Plan-then-execute: a planner emits a list of steps, an executor runs each
 * step in order, and an aggregator produces the final output.
 *
 * State must include `plan: string[]` (or be populated by the planner) and
 * `cursor: number` (defaults to 0).
 */
export interface PlanExecuteState {
  plan?: string[];
  cursor?: number;
  results?: string[];
  finalAnswer?: string;
}

export function planExecuteGraph<TState extends PlanExecuteState>(nodes: {
  planner: GraphNodeFn<TState>;
  executor: GraphNodeFn<TState>;
  aggregator: GraphNodeFn<TState>;
}): AgentGraph<TState> {
  return new AgentGraph<TState>()
    .addNode('planner', nodes.planner)
    .addNode('executor', nodes.executor)
    .addNode('aggregator', nodes.aggregator)
    .addEdge('planner', 'executor', (ctx) => (ctx.state.plan?.length ?? 0) > 0)
    .addEdge('planner', END, (ctx) => (ctx.state.plan?.length ?? 0) === 0)
    .addEdge('executor', 'executor', (ctx) => (ctx.state.cursor ?? 0) < (ctx.state.plan?.length ?? 0))
    .addEdge('executor', 'aggregator')
    .addEdge('aggregator', END)
    .setEntry('planner');
}
