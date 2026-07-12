import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/agent-runtime.js';
import { CircuitBreaker } from '../src/core/circuit-breaker.js';
import { MemoryStore } from '../src/core/memory-store.js';
import { PolicyEngine } from '../src/core/policy-engine.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { sleep, withRetry } from '../src/retry/retry-policy.js';
import type { BrainProvider } from '../src/brain/brain.js';
import type { Session, ToolCall } from '../src/types.js';

function makeSession(): Session {
  return {
    id: 'sess-v43',
    channel: 'test',
    userId: 'owner',
    trustLevel: 'owner',
    role: 'user',
    agentId: 'garud',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    settings: {}
  } as unknown as Session;
}

function makeBrain(calls: ToolCall[]): BrainProvider {
  return {
    name: 'test-brain',
    plan: () => ({ summary: 'test', memoryQueries: [], toolCalls: calls }),
    compose: (ctx) => ({
      text: ctx.toolOutputs.map(({ result }) => result.content).join(' | ') || 'no tools ran',
      notes: [],
      usedTools: ctx.toolOutputs.map(({ tool }) => tool),
      usedMemories: []
    })
  };
}

function makeRuntime(brain: BrainProvider, tools: ToolRegistry, options = {}): AgentRuntime {
  return new AgentRuntime(brain, new MemoryStore(), tools, new PolicyEngine(), options);
}

describe('v4.3.0 "Cirrostratus" — framework resilience', () => {
  describe('CircuitBreaker half-open probe', () => {
    it('admits exactly one probe at a time in half-open', () => {
      let now = 0;
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
      cb.setTimeProvider(() => now);
      cb.recordFailure();
      now += 1500;
      expect(cb.allowRequest()).toBe(true); // the single probe
      expect(cb.getState()).toBe('half-open');
      expect(cb.allowRequest()).toBe(false); // concurrent caller rejected
      cb.recordSuccess();
      expect(cb.allowRequest()).toBe(true); // closed again
    });

    it('a failed probe re-opens, and a fresh probe is allowed after cooldown', () => {
      let now = 0;
      const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
      cb.setTimeProvider(() => now);
      cb.recordFailure();
      now += 1500;
      cb.allowRequest();
      cb.recordFailure();
      expect(cb.getState()).toBe('open');
      now += 1500;
      expect(cb.allowRequest()).toBe(true);
      expect(cb.allowRequest()).toBe(false);
    });
  });

  describe('abort-aware retry backoff', () => {
    it('sleep resolves early when the signal aborts', async () => {
      const ac = new AbortController();
      const started = Date.now();
      const pending = sleep(5000, ac.signal);
      setTimeout(() => ac.abort(), 20);
      await pending;
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('withRetry stops during backoff when aborted', async () => {
      const ac = new AbortController();
      let attempts = 0;
      const started = Date.now();
      const pending = withRetry(async () => {
        attempts += 1;
        throw new Error('boom');
      }, { attempts: 5, baseMs: 3000, jitter: false, signal: ac.signal });
      setTimeout(() => ac.abort(), 30);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(attempts).toBe(1);
      expect(Date.now() - started).toBeLessThan(2500);
    });
  });

  describe('AgentRuntime abort handling', () => {
    it('an aborted request skips remaining tool calls', async () => {
      let executions = 0;
      const tools = new ToolRegistry();
      tools.register({
        name: 'test.count',
        description: 'counts invocations',
        execute: () => {
          executions += 1;
          return { content: 'ok' };
        }
      });
      const brain = makeBrain([
        { tool: 'test.count', input: '' },
        { tool: 'test.count', input: '' }
      ]);
      const runtime = makeRuntime(brain, tools);
      const ac = new AbortController();
      ac.abort();
      const reply = await runtime.reply(makeSession(), 'go', ac.signal);
      expect(executions).toBe(0);
      expect(reply.usedTools).toHaveLength(0);
    });
  });

  describe('AgentRuntime per-tool circuit breakers', () => {
    it('opens a circuit for a repeatedly failing tool and short-circuits it', async () => {
      let executions = 0;
      const tools = new ToolRegistry();
      tools.register({
        name: 'test.flaky',
        description: 'always fails',
        execute: () => {
          executions += 1;
          return { content: 'nope', error: true };
        }
      });
      const brain = makeBrain([{ tool: 'test.flaky', input: '' }]);
      const runtime = makeRuntime(brain, tools, { breaker: { failureThreshold: 2, cooldownMs: 60_000 } });
      const session = makeSession();
      await runtime.reply(session, 'one');
      await runtime.reply(session, 'two');
      expect(runtime.getToolCircuitState('test.flaky')).toBe('open');
      const third = await runtime.reply(session, 'three');
      expect(executions).toBe(2); // third invocation was short-circuited
      expect(third.text).toContain('circuit open');
    });

    it('healthy tools keep their circuit closed', async () => {
      const tools = new ToolRegistry();
      tools.register({ name: 'test.ok', description: 'fine', execute: () => ({ content: 'fine' }) });
      const brain = makeBrain([{ tool: 'test.ok', input: '' }]);
      const runtime = makeRuntime(brain, tools, { breaker: { failureThreshold: 2, cooldownMs: 60_000 } });
      const session = makeSession();
      await runtime.reply(session, 'one');
      await runtime.reply(session, 'two');
      await runtime.reply(session, 'three');
      expect(runtime.getToolCircuitState('test.ok')).toBe('closed');
    });

    it('circuit state is undefined when breakers are disabled', async () => {
      const tools = new ToolRegistry();
      tools.register({ name: 'test.ok', description: 'fine', execute: () => ({ content: 'fine' }) });
      const runtime = makeRuntime(makeBrain([{ tool: 'test.ok', input: '' }]), tools);
      await runtime.reply(makeSession(), 'one');
      expect(runtime.getToolCircuitState('test.ok')).toBeUndefined();
    });
  });
});
