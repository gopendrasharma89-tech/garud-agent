import type { BrainProvider, BrainPlanContext, BrainComposeContext } from './brain.js';
import type { AgentPlan, AgentReply } from '../types.js';
import type { CostTracker } from '../cost/cost-tracker.js';

/**
 * Decorator that wraps any BrainProvider and records token / call usage into
 * a CostTracker on each plan() / compose() invocation. Token estimates use a
 * cheap 1-token-per-4-chars heuristic when the underlying provider does not
 * surface real usage numbers (the OpenAI brain currently doesn't expose
 * `response.usage` through the BrainProvider contract).
 *
 * The wrapped instance is transparent — same `name`, same `plan`/`compose`
 * surface — so it can be dropped in wherever a BrainProvider is expected.
 */
export class AutoCostBrain implements BrainProvider {
  public readonly name: string;

  constructor(
    private readonly inner: BrainProvider,
    private readonly cost: CostTracker,
    private readonly opts: { sessionIdFallback?: string } = {}
  ) {
    this.name = inner.name;
  }

  async plan(ctx: BrainPlanContext): Promise<AgentPlan> {
    const plan = await Promise.resolve(this.inner.plan(ctx));
    const tokensIn = estimateTokens(ctx.input);
    const tokensOut = estimateTokens(JSON.stringify(plan));
    this.cost.record({
      sessionId: ctx.session?.id ?? this.opts.sessionIdFallback ?? 'unknown',
      requestId: `plan-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      tokensIn,
      tokensOut,
      toolCalls: 0,
      labels: { brain: this.name, op: 'plan' }
    });
    return plan;
  }

  async compose(ctx: BrainComposeContext): Promise<AgentReply> {
    const reply = await Promise.resolve(this.inner.compose(ctx));
    const tokensIn = estimateTokens(ctx.input) + (ctx.toolOutputs ?? []).reduce(
      (sum, t) => sum + estimateTokens(JSON.stringify(t.result?.content ?? '')), 0);
    const tokensOut = estimateTokens(reply?.text ?? '');
    this.cost.record({
      sessionId: ctx.session?.id ?? this.opts.sessionIdFallback ?? 'unknown',
      requestId: `compose-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      tokensIn,
      tokensOut,
      toolCalls: (ctx.toolOutputs ?? []).length,
      labels: { brain: this.name, op: 'compose' }
    });
    return reply;
  }
}

/** Cheap deterministic token estimator: ~1 token per 4 chars. */
function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}
