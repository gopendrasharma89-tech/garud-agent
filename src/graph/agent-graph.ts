/**
 * Graph-based agent orchestration (LangGraph-inspired).
 *
 * A graph is a directed set of nodes (functions) connected by edges
 * (possibly conditional). Each run carries a shared `state` object that
 * nodes can read and mutate. Conditional edges decide the next node by
 * inspecting the state. Loops are allowed but bounded by `maxSteps`.
 */

export type NodeId = string;

export interface GraphContext<TState> {
  state: TState;
  step: number;
  history: NodeId[];
  /** Free-form metadata; useful for tracing and observability. */
  meta: Record<string, unknown>;
}

export type GraphNodeFn<TState> = (ctx: GraphContext<TState>) => Promise<Partial<TState> | void> | Partial<TState> | void;
export type EdgeCondition<TState> = (ctx: GraphContext<TState>) => boolean | string | Promise<boolean | string>;

interface Edge<TState> {
  from: NodeId;
  to: NodeId;
  condition?: EdgeCondition<TState>;
}

export interface GraphRunResult<TState> {
  state: TState;
  history: NodeId[];
  steps: number;
  status: 'completed' | 'maxSteps' | 'unknownNode' | 'error';
  error?: string;
}

const ENTRY: NodeId = '__entry__';
export const END: NodeId = '__end__';

export class AgentGraph<TState> {
  private readonly nodes = new Map<NodeId, GraphNodeFn<TState>>();
  private readonly edges: Edge<TState>[] = [];
  private entry?: NodeId;

  /** Register a node. Returns `this` for fluent chaining. */
  addNode(id: NodeId, fn: GraphNodeFn<TState>): this {
    if (id === ENTRY || id === END) throw new Error(`reserved node id: ${id}`);
    if (this.nodes.has(id)) throw new Error(`node already registered: ${id}`);
    this.nodes.set(id, fn);
    return this;
  }

  /** Connect two nodes. Optional condition decides whether the edge fires. */
  addEdge(from: NodeId, to: NodeId, condition?: EdgeCondition<TState>): this {
    this.edges.push({ from, to, condition });
    return this;
  }

  /** Designate which node executes first. */
  setEntry(id: NodeId): this { this.entry = id; return this; }

  /** Execute the graph until END or maxSteps reached. */
  async run(initialState: TState, opts: { maxSteps?: number } = {}): Promise<GraphRunResult<TState>> {
    const maxSteps = opts.maxSteps ?? 32;
    if (!this.entry) return { state: initialState, history: [], steps: 0, status: 'error', error: 'no entry node' };

    // Use structuredClone when possible; fall back to JSON clone for state
    // containing functions or other non-cloneable values; if even that fails,
    // use the original reference (caller-beware).
    let clonedState: TState;
    try {
      clonedState = structuredClone(initialState);
    } catch {
      try {
        clonedState = JSON.parse(JSON.stringify(initialState)) as TState;
      } catch {
        clonedState = initialState;
      }
    }
    const ctx: GraphContext<TState> = {
      state: clonedState,
      step: 0,
      history: [],
      meta: {}
    };

    let current: NodeId = this.entry;
    try {
      while (current !== END) {
        if (ctx.step >= maxSteps) {
          return { state: ctx.state, history: ctx.history, steps: ctx.step, status: 'maxSteps' };
        }
        const fn = this.nodes.get(current);
        if (!fn) {
          return { state: ctx.state, history: ctx.history, steps: ctx.step, status: 'unknownNode', error: current };
        }
        ctx.history.push(current);
        const patch = await fn(ctx);
        if (patch && typeof patch === 'object') Object.assign(ctx.state as object, patch);
        ctx.step += 1;
        current = await this.nextNode(current, ctx);
      }
      return { state: ctx.state, history: ctx.history, steps: ctx.step, status: 'completed' };
    } catch (error) {
      return {
        state: ctx.state,
        history: ctx.history,
        steps: ctx.step,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async nextNode(from: NodeId, ctx: GraphContext<TState>): Promise<NodeId> {
    const candidates = this.edges.filter((e) => e.from === from);
    if (candidates.length === 0) return END;
    for (const edge of candidates) {
      if (!edge.condition) return edge.to;
      const verdict = await edge.condition(ctx);
      if (verdict === true) return edge.to;
      if (typeof verdict === 'string') return verdict;
    }
    return END;
  }

  /** Number of registered nodes. */
  size(): number { return this.nodes.size; }
  /** Snapshot of node + edge graph for diagnostics. */
  describe(): { entry: NodeId | undefined; nodes: NodeId[]; edges: Array<{ from: NodeId; to: NodeId; conditional: boolean }> } {
    return {
      entry: this.entry,
      nodes: [...this.nodes.keys()],
      edges: this.edges.map((e) => ({ from: e.from, to: e.to, conditional: !!e.condition }))
    };
  }
}
