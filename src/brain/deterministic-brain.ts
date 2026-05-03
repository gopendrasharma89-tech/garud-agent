import { AgentPlan, AgentReply, ToolCall } from '../types.js';
import { truncate } from '../utils/text.js';
import { BrainComposeContext, BrainPlanContext, BrainProvider } from './brain.js';

interface IntentRule {
  match: (lowered: string) => boolean;
  toolCalls: (input: string) => ToolCall[];
}

/**
 * Lightweight rule-based brain with no external dependencies. Useful for
 * offline mode, tests, and as a fallback when LLM providers are unavailable.
 */
export class DeterministicBrain implements BrainProvider {
  readonly name = 'deterministic';

  private readonly rules: IntentRule[] = [
    {
      match: (s) => /(remember|^save\s|^note\s|yaad|store this)/i.test(s),
      toolCalls: (input) => [{ tool: 'memory.save', input }]
    },
    {
      match: (s) => /(recall|what did|history|remembered|search memory|what do you know)/i.test(s),
      toolCalls: (input) => [{ tool: 'memory.search', input }]
    },
    {
      match: (s) => /(status|health|alive|ping)/i.test(s),
      toolCalls: () => [{ tool: 'status', input: 'health' }]
    },
    {
      match: (s) => /(time|date|now|kitne baje)/i.test(s),
      toolCalls: () => [{ tool: 'time.now', input: '' }]
    },
    {
      match: (s) => /(calculate|calc|compute|=|\+|\-|\*|\/| times | plus | divided)/i.test(s),
      toolCalls: (input) => [{ tool: 'math.eval', input }]
    },
    {
      match: (s) => /(uuid|random id|new id)/i.test(s),
      toolCalls: () => [{ tool: 'random.uuid', input: '' }]
    },
    {
      match: (s) => /(base64\s+encode|encode base64)/i.test(s),
      toolCalls: (input) => [{ tool: 'base64.encode', input: input.replace(/.*?(?:base64\s+encode|encode base64)\s*/i, '') }]
    },
    {
      match: (s) => /(sha256|sha-256|^hash\b)/i.test(s),
      toolCalls: (input) => [{ tool: 'hash.sha256', input }]
    },
    {
      match: (s) => /(echo|repeat after me)/i.test(s),
      toolCalls: (input) => [{ tool: 'echo', input }]
    }
  ];

  plan(context: BrainPlanContext): AgentPlan {
    const lowered = context.input.toLowerCase();
    const toolCalls: ToolCall[] = [];
    for (const rule of this.rules) {
      if (rule.match(lowered)) toolCalls.push(...rule.toolCalls(context.input));
    }
    const memoryQueries = context.input.trim().length > 8 ? [context.input] : [];
    return { summary: 'deterministic-plan', memoryQueries, toolCalls };
  }

  compose(context: BrainComposeContext): AgentReply {
    const savedNow = context.toolOutputs.some(({ tool, result }) =>
      tool === 'memory.save' && !result.error);
    const memorySummary = context.memories.length
      ? `Relevant memory: ${context.memories.map((m) => truncate(m.text, 80)).join(' | ')}`
      : savedNow
        ? 'Fresh memory captured in this turn.'
        : 'No strong memory found yet.';

    const toolSummary = context.toolOutputs.length
      ? context.toolOutputs
          .map(({ tool, result }) => `${tool}${result.error ? ' (error)' : ''}: ${truncate(result.content, 200)}`)
          .join(' | ')
      : 'No tools were needed.';

    const historyHint = context.history?.length
      ? ` Recent: ${context.history.slice(-2).map((t) => truncate(t.input, 40)).join(' | ')}`
      : '';

    const greeting = context.persona
      ? truncate(context.persona, 60)
      : `Agent ready for ${context.session.userId}.`;

    const text = [
      greeting,
      memorySummary,
      toolSummary,
      `Request: ${truncate(context.input, 200)}${historyHint}`
    ].join(' ');

    return {
      text,
      notes: ['policy-aware', 'local-first', 'deterministic'],
      usedTools: context.toolOutputs.map(({ tool }) => tool),
      usedMemories: context.memories.map((memory) => memory.id),
      citations: context.memories.map((m) => ({ id: m.id, text: truncate(m.text, 100) }))
    };
  }
}
