import { AuditLogger } from '../core/audit-log.js';
import { MemoryStore } from '../core/memory-store.js';
import { PolicyEngine } from '../core/policy-engine.js';
import { ToolRegistry } from '../core/tool-registry.js';
import { ToolCache } from '../cache/tool-cache.js';
import { ToolQuotaManager } from '../quotas/tool-quota.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { MetricsRegistry } from '../metrics/registry.js';
import { AgentReply, ConversationTurn, Logger, Session, ToolResult } from '../types.js';
import { noopLogger } from '../utils/logger.js';
import { truncate } from '../utils/text.js';
import { BrainProvider } from '../brain/brain.js';
import { CircuitBreaker, CircuitBreakerOptions, CircuitState } from '../core/circuit-breaker.js';

export interface AgentRuntimeOptions {
  maxToolsPerTurn?: number;
  toolTimeoutMs?: number;
  maxToolResultChars?: number;
  contextTurns?: number;
  persona?: string;
  logger?: Logger;
  audit?: AuditLogger;
  cache?: ToolCache;
  quotas?: ToolQuotaManager;
  conversation?: ConversationStore;
  metrics?: MetricsRegistry;
  skillsLoader?: (input: string) => Array<{ name: string; content: string }>;
  /** Per-tool circuit breaker settings; omit to disable breakers. */
  breaker?: CircuitBreakerOptions;
}

export class AgentRuntime {
  private readonly logger: Logger;
  private readonly maxToolsPerTurn: number;
  private readonly toolTimeoutMs: number;
  private readonly maxToolResultChars: number;
  private readonly contextTurns: number;
  private readonly persona?: string;
  private readonly audit?: AuditLogger;
  private readonly cache?: ToolCache;
  private readonly quotas?: ToolQuotaManager;
  private readonly conversation?: ConversationStore;
  private readonly metrics?: MetricsRegistry;
  private readonly skillsLoader?: AgentRuntimeOptions['skillsLoader'];
  private readonly breakerOptions?: CircuitBreakerOptions;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly brain: BrainProvider,
    private readonly memories: MemoryStore,
    private readonly tools: ToolRegistry,
    private readonly policy: PolicyEngine,
    options: AgentRuntimeOptions = {}
  ) {
    this.logger = options.logger ?? noopLogger;
    this.maxToolsPerTurn = options.maxToolsPerTurn ?? 6;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 5000;
    this.maxToolResultChars = options.maxToolResultChars ?? 4096;
    this.contextTurns = options.contextTurns ?? 0;
    this.persona = options.persona;
    this.audit = options.audit;
    this.cache = options.cache;
    this.quotas = options.quotas;
    this.conversation = options.conversation;
    this.metrics = options.metrics;
    this.skillsLoader = options.skillsLoader;
    this.breakerOptions = options.breaker;
    this.registerMetrics();
    this.applyToolQuotas();
  }

  getBrainName(): string {
    return this.brain.name;
  }

  private registerMetrics(): void {
    if (!this.metrics) return;
    this.metrics.counter('garud_tool_invocations_total', 'Total tool invocations');
    this.metrics.counter('garud_tool_errors_total', 'Tool invocations that errored');
    this.metrics.counter('garud_tool_blocked_total', 'Tool invocations blocked by policy');
    this.metrics.counter('garud_tool_quota_exceeded_total', 'Tool invocations rejected due to quota');
    this.metrics.counter('garud_tool_circuit_open_total', 'Tool invocations rejected by an open circuit');
    this.metrics.histogram('garud_tool_duration_ms', 'Tool latency in ms',
      [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
  }

  private applyToolQuotas(): void {
    if (!this.quotas) return;
    for (const tool of this.tools.list()) {
      if (tool.dailyQuota !== undefined) {
        this.quotas.setToolLimit(tool.name, tool.dailyQuota);
      }
    }
  }

  private breakerFor(tool: string): CircuitBreaker | undefined {
    if (!this.breakerOptions) return undefined;
    let breaker = this.breakers.get(tool);
    if (!breaker) {
      breaker = new CircuitBreaker(this.breakerOptions);
      this.breakers.set(tool, breaker);
    }
    return breaker;
  }

  /** Inspect a tool's circuit state (undefined when breakers are disabled). */
  getToolCircuitState(tool: string): CircuitState | undefined {
    return this.breakerFor(tool)?.getState();
  }

  async reply(
    session: Session,
    input: string,
    signal?: AbortSignal,
    requestId?: string
  ): Promise<AgentReply> {
    const log = this.logger.child(`runtime:${session.id.slice(0, 8)}`);
    const plan = await this.brain.plan({
      input,
      session,
      availableTools: this.tools.list(),
      recentMemories: this.memories.list(session.id).slice(-10),
      signal
    });
    log.debug('plan ready', { toolCalls: plan.toolCalls.length, requestId });

    const recalled = plan.memoryQueries.flatMap((query) =>
      this.memories.search(session.id, query, 3));
    const uniqueMemories = [...new Map(recalled.map((m) => [m.id, m])).values()];

    const toolOutputs: Array<{ tool: string; result: ToolResult }> = [];
    const allowed = plan.toolCalls.slice(0, this.maxToolsPerTurn);
    for (const call of allowed) {
      // Stop executing tools once the request has been aborted.
      if (signal?.aborted) {
        log.warn('request aborted; skipping remaining tool calls', { requestId });
        break;
      }
      const tool = this.tools.get(call.tool);
      if (!tool) {
        const suggestion = this.tools.suggest(call.tool);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : '';
        toolOutputs.push({ tool: call.tool, result: { content: `unknown tool: ${call.tool}${hint}`, error: true } });
        continue;
      }
      const decision = this.policy.decide(session, tool);
      await this.safeAudit('policy', {
        tool: tool.name,
        allow: decision.allow,
        reason: decision.reason,
        sandbox: decision.sandbox ?? false
      }, session.id, requestId);
      if (!decision.allow) {
        this.metrics?.inc('garud_tool_blocked_total', { tool: tool.name });
        toolOutputs.push({
          tool: tool.name,
          result: { content: `blocked by policy (${decision.reason})`, error: true }
        });
        continue;
      }

      // Quota check.
      if (this.quotas) {
        const q = this.quotas.consume(session.id, tool.name);
        if (!q.allowed) {
          this.metrics?.inc('garud_tool_quota_exceeded_total', { tool: tool.name });
          await this.safeAudit('quota', {
            tool: tool.name, exhausted: true, resetAt: q.resetAt, limit: q.limit
          }, session.id, requestId);
          toolOutputs.push({
            tool: tool.name,
            result: { content: `quota exceeded for ${tool.name}; resets at ${new Date(q.resetAt).toISOString()}`, error: true }
          });
          continue;
        }
      }

      // Circuit breaker check: short-circuit tools that keep failing.
      const breaker = this.breakerFor(tool.name);
      if (breaker && !breaker.allowRequest()) {
        this.metrics?.inc('garud_tool_circuit_open_total', { tool: tool.name });
        await this.safeAudit('tool', { tool: tool.name, circuitOpen: true }, session.id, requestId);
        toolOutputs.push({
          tool: tool.name,
          result: { content: `circuit open for ${tool.name}: cooling down after repeated failures`, error: true }
        });
        continue;
      }

      // Cache lookup.
      let result: ToolResult | undefined;
      if (this.cache && tool.cacheable) {
        result = this.cache.get(tool.name, call.input);
        if (result) log.debug('tool cache hit', { tool: tool.name });
      }

      const startedAt = Date.now();
      if (!result) {
        result = await this.tools.invoke(tool.name, call.input, {
          session,
          requestText: input,
          now: Date.now(),
          log: log.child(`tool:${tool.name}`),
          signal: signal ?? new AbortController().signal,
          sandbox: decision.sandbox ?? false,
          requestId,
          invoke: async (subName, subInput) => this.tools.invoke(subName, subInput, {
            session,
            requestText: input,
            now: Date.now(),
            log: log.child(`tool:${tool.name}->${subName}`),
            signal: signal ?? new AbortController().signal,
            sandbox: decision.sandbox ?? false,
            requestId
          }, { timeoutMs: this.toolTimeoutMs })
        }, { timeoutMs: this.toolTimeoutMs, logger: log, sandbox: decision.sandbox ?? false });
        if (breaker) {
          if (result.error) breaker.recordFailure();
          else breaker.recordSuccess();
        }
        if (this.cache && tool.cacheable && !result.error) {
          this.cache.set(tool.name, call.input, result);
        }
      }

      // Auto-truncate huge results.
      if (result.content.length > this.maxToolResultChars) {
        result = {
          ...result,
          content: truncate(result.content, this.maxToolResultChars),
          metadata: { ...(result.metadata ?? {}), truncated: true }
        };
      }

      this.metrics?.inc('garud_tool_invocations_total', { tool: tool.name });
      if (result.error) this.metrics?.inc('garud_tool_errors_total', { tool: tool.name });
      this.metrics?.observe('garud_tool_duration_ms', Date.now() - startedAt, { tool: tool.name });

      toolOutputs.push({ tool: tool.name, result });
      await this.safeAudit('tool', {
        tool: tool.name,
        error: !!result.error,
        durationMs: Date.now() - startedAt,
        contentPreview: result.content.slice(0, 120)
      }, session.id, requestId);
    }

    const skills = this.skillsLoader?.(input) ?? [];
    const history: ConversationTurn[] = this.conversation && this.contextTurns > 0
      ? this.conversation.recent(session.id, this.contextTurns)
      : [];

    const reply = await this.brain.compose({
      input,
      session,
      memories: uniqueMemories,
      toolOutputs,
      persona: this.persona,
      skills,
      history,
      signal
    });

    await this.safeAudit('reply', {
      tools: reply.usedTools,
      memoryCount: reply.usedMemories.length,
      preview: reply.text.slice(0, 200)
    }, session.id, requestId);

    if (this.conversation) {
      this.conversation.append({
        sessionId: session.id,
        requestId,
        input,
        reply: reply.text,
        toolsUsed: reply.usedTools
      });
    }

    return { ...reply, requestId };
  }

  /** Wrap audit.record so errors never bubble into the runtime path. */
  private async safeAudit(
    kind: Parameters<NonNullable<AgentRuntimeOptions['audit']>['record']>[0],
    detail: Record<string, unknown>,
    sessionId?: string,
    requestId?: string
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.record(kind, detail, sessionId, requestId);
    } catch (error) {
      this.logger.warn('audit failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
