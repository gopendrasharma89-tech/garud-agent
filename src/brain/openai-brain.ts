import { AgentPlan, AgentReply, ToolCall } from '../types.js';
import { truncate } from '../utils/text.js';
import { extractJsonObject } from '../utils/json-extract.js';
import { withTimeout } from '../utils/timeout.js';
import { CircuitBreaker } from '../core/circuit-breaker.js';
import { BrainComposeContext, BrainPlanContext, BrainProvider } from './brain.js';
import { DeterministicBrain } from './deterministic-brain.js';

export interface OpenAiBrainOptions {
  apiBase: string;
  apiKey: string;
  model: string;
  temperature?: number;
  fetchImpl?: typeof fetch;
  maxTokens?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  /** Extra headers for proxy/OpenRouter compatibility. */
  extraHeaders?: Record<string, string>;
  /**
   * 'llm' sends each turn through the model to pick tool calls and memory
   * queries (strict-JSON contract, validated, deterministic fallback).
   * 'deterministic' (default) keeps the zero-cost rule-based planner.
   */
  planningMode?: 'llm' | 'deterministic';
  /** Max tool calls the LLM planner may emit per turn (default 6). */
  planningMaxToolCalls?: number;
}

/**
 * OpenAI-compatible chat completions brain. Falls back to the deterministic
 * brain if any network/parse error occurs OR if the circuit breaker is open.
 */
export class OpenAiBrain implements BrainProvider {
  readonly name = 'openai-compatible';
  private readonly fallback = new DeterministicBrain();
  private readonly breaker: CircuitBreaker;

  constructor(private readonly options: OpenAiBrainOptions) {
    this.breaker = new CircuitBreaker({
      failureThreshold: options.failureThreshold,
      cooldownMs: options.cooldownMs
    });
  }

  getBreaker(): CircuitBreaker {
    return this.breaker;
  }

  async plan(context: BrainPlanContext): Promise<AgentPlan> {
    if ((this.options.planningMode ?? 'deterministic') !== 'llm' || !this.breaker.allowRequest()) {
      return this.fallback.plan(context);
    }
    try {
      const raw = await this.callApi(this.buildPlanMessages(context), context.signal, {
        temperature: 0.1,
        maxTokens: 600
      });
      const plan = sanitizeAgentPlan(
        extractJsonObject(raw),
        context.availableTools.map((t) => t.name),
        this.options.planningMaxToolCalls ?? 6
      );
      if (!plan) throw new Error('LLM returned an unparseable plan');
      this.breaker.recordSuccess();
      return plan;
    } catch {
      this.breaker.recordFailure();
      const fb = await Promise.resolve(this.fallback.plan(context));
      return { ...fb, summary: `${fb.summary} [llm-plan-fallback]` };
    }
  }

  /**
   * Breaker-aware raw completion for a single prompt. Used by LlmPlanner and
   * other subsystems that need model text without the compose() scaffolding.
   */
  async completeText(prompt: string, signal?: AbortSignal): Promise<string> {
    if (!this.breaker.allowRequest()) throw new Error('llm-circuit-open');
    try {
      const text = await this.callApi([{ role: 'user', content: prompt }], signal, { temperature: 0.2 });
      this.breaker.recordSuccess();
      return text;
    } catch (error) {
      this.breaker.recordFailure();
      throw error;
    }
  }

  private buildPlanMessages(context: BrainPlanContext): Array<{ role: string; content: string }> {
    const maxCalls = this.options.planningMaxToolCalls ?? 6;
    const toolCatalog = context.availableTools
      .map((t) => `- ${t.name}: ${truncate(t.description ?? '', 120)}`)
      .join('\n');
    const memoryBlock = context.recentMemories.length
      ? 'Recent memories:\n' + context.recentMemories.slice(-5).map((m) => `- ${truncate(m.text, 120)}`).join('\n')
      : 'No recent memories.';
    const system = [
      'You are the planning module of the Garud agent. Decide which tools to call',
      'and which memory queries to run for the user request below.',
      'Respond with ONLY a JSON object:',
      '{"summary": string, "memoryQueries": string[], "toolCalls": [{"tool": string, "input": string}]}',
      `Rules: use only listed tools; at most ${maxCalls} tool calls; use empty arrays when nothing is needed;`,
      '"input" is the exact string argument passed to the tool (JSON-encoded when the tool expects JSON).',
      `Session: user=${context.session.userId} channel=${context.session.channel} trust=${context.session.trustLevel}`,
      memoryBlock,
      'Available tools:',
      toolCatalog
    ].join('\n');
    return [
      { role: 'system', content: system },
      { role: 'user', content: context.input }
    ];
  }

  async compose(context: BrainComposeContext): Promise<AgentReply> {
    if (!this.breaker.allowRequest()) {
      const fb = this.fallback.compose(context);
      return {
        ...fb,
        text: fb.text + ' [llm-circuit-open]',
        notes: [...fb.notes, 'llm-circuit-open']
      };
    }
    try {
      const messages = this.buildMessages(context);
      const text = await this.callApi(messages, context.signal);
      this.breaker.recordSuccess();
      return {
        text,
        notes: ['policy-aware', 'llm', this.options.model],
        usedTools: context.toolOutputs.map(({ tool }) => tool),
        usedMemories: context.memories.map((m) => m.id),
        citations: context.memories.map((m) => ({ id: m.id, text: truncate(m.text, 120) }))
      };
    } catch (error) {
      this.breaker.recordFailure();
      const fb = this.fallback.compose(context);
      const msg = error instanceof Error ? error.message : String(error);
      return {
        ...fb,
        text: fb.text + ` [llm-fallback: ${truncate(msg, 80)}]`,
        notes: [...fb.notes, 'llm-fallback']
      };
    }
  }

  private buildMessages(context: BrainComposeContext): Array<{ role: string; content: string }> {
    const persona = context.persona ?? 'You are Garud, a helpful local-first AI assistant. Be concise.';
    const memoryBlock = context.memories.length
      ? 'Relevant memories:\n' + context.memories.map((m) => `- ${m.text}`).join('\n')
      : 'No relevant memories.';
    const toolBlock = context.toolOutputs.length
      ? 'Tool outputs:\n' + context.toolOutputs
          .map(({ tool, result }) => `- ${tool}${result.error ? ' (error)' : ''}: ${truncate(result.content, 400)}`)
          .join('\n')
      : 'No tool outputs this turn.';
    const skillsBlock = context.skills?.length
      ? 'Skills:\n' + context.skills.map((s) => `# ${s.name}\n${s.content}`).join('\n\n')
      : '';
    const historyBlock = context.history?.length
      ? 'Recent turns:\n' + context.history.slice(-5).map((t) =>
          `- user: ${truncate(t.input, 150)}\n  assistant: ${truncate(t.reply, 200)}`
        ).join('\n')
      : '';

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: persona },
      {
        role: 'system',
        content: `Session: user=${context.session.userId} channel=${context.session.channel} trust=${context.session.trustLevel} agent=${context.session.agentId}`
      },
      { role: 'system', content: memoryBlock },
      { role: 'system', content: toolBlock }
    ];
    if (skillsBlock) messages.push({ role: 'system', content: skillsBlock });
    if (historyBlock) messages.push({ role: 'system', content: historyBlock });
    messages.push({ role: 'user', content: context.input });
    return messages;
  }

  private async callApi(
    messages: Array<{ role: string; content: string }>,
    externalSignal?: AbortSignal,
    overrides: { temperature?: number; maxTokens?: number } = {}
  ): Promise<string> {
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    if (!fetchFn) throw new Error('fetch is not available in this runtime');
    const url = this.options.apiBase.replace(/\/$/, '') + '/chat/completions';

    const controller = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.options.apiKey}`,
      ...(this.options.extraHeaders ?? {})
    };

    const request = fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.options.model,
        messages,
        temperature: overrides.temperature ?? this.options.temperature ?? 0.4,
        max_tokens: overrides.maxTokens ?? this.options.maxTokens ?? 800
      }),
      signal: controller.signal
    });

    const response = await withTimeout(request, this.options.timeoutMs ?? 0, controller);
    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch { body = ''; }
      throw new Error(`LLM HTTP ${response.status}: ${truncate(body, 200)}`);
    }
    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty LLM response');
    return text;
  }
}

/**
 * Validate and normalize a model-emitted {@link AgentPlan}. Unknown tools are
 * dropped, inputs are coerced to strings, memoryQueries are capped, and the
 * whole plan is rejected (undefined) when the shape is not an object.
 */
export function sanitizeAgentPlan(
  value: unknown,
  availableToolNames: string[],
  maxToolCalls: number
): AgentPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as { summary?: unknown; memoryQueries?: unknown; toolCalls?: unknown };
  const known = new Set(availableToolNames);

  const memoryQueries = Array.isArray(v.memoryQueries)
    ? v.memoryQueries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map((q) => q.trim().slice(0, 200)).slice(0, 3)
    : [];

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(v.toolCalls)) {
    for (const raw of v.toolCalls) {
      if (toolCalls.length >= Math.max(0, maxToolCalls)) break;
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as { tool?: unknown; input?: unknown };
      if (typeof r.tool !== 'string' || !known.has(r.tool)) continue;
      const input = typeof r.input === 'string'
        ? r.input
        : r.input === undefined || r.input === null ? '' : JSON.stringify(r.input);
      toolCalls.push({ tool: r.tool, input });
    }
  }

  return {
    summary: typeof v.summary === 'string' && v.summary.trim() ? v.summary.trim().slice(0, 300) : 'llm-plan',
    memoryQueries,
    toolCalls
  };
}
