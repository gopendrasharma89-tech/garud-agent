import { AgentReply } from '../types.js';
import { truncate } from '../utils/text.js';
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

  plan(context: BrainPlanContext) {
    return this.fallback.plan(context);
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
    externalSignal?: AbortSignal
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
        temperature: this.options.temperature ?? 0.4,
        max_tokens: this.options.maxTokens ?? 800
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
