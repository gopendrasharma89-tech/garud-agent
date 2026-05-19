import { describe, it, expect } from 'vitest';
import { AgentGraph, END } from '../src/graph/agent-graph.js';
import { reflectAndRevise, textHeuristicReflector } from '../src/reflection/reflector.js';
import { HeuristicPlanner, buildPlan } from '../src/planning/planner.js';
import { EmbeddingStore } from '../src/embeddings/embedding-store.js';
import { CostTracker } from '../src/cost/cost-tracker.js';
import { Tracer } from '../src/tracing/span.js';
import { withRetry, retryNetworkErrors } from '../src/retry/retry-policy.js';
import { Crew, roundRobinSupervisor } from '../src/crew/crew.js';

// ──────────────────── AgentGraph ────────────────────
describe('v3.2 AgentGraph', () => {
  it('runs a linear graph A → B → END', async () => {
    const g = new AgentGraph<{ count: number }>();
    g.addNode('A', (ctx) => { ctx.state.count += 1; })
     .addNode('B', (ctx) => { ctx.state.count += 10; })
     .addEdge('A', 'B')
     .addEdge('B', END)
     .setEntry('A');
    const r = await g.run({ count: 0 });
    expect(r.status).toBe('completed');
    expect(r.state.count).toBe(11);
    expect(r.history).toEqual(['A', 'B']);
  });

  it('conditional edges route based on state', async () => {
    const g = new AgentGraph<{ value: number }>();
    g.addNode('start', () => {})
     .addNode('small', (ctx) => ({ value: ctx.state.value + 1 }))
     .addNode('big', (ctx) => ({ value: ctx.state.value + 100 }))
     .addEdge('start', 'small', (ctx) => ctx.state.value < 10)
     .addEdge('start', 'big', (ctx) => ctx.state.value >= 10)
     .addEdge('small', END)
     .addEdge('big', END)
     .setEntry('start');
    expect((await g.run({ value: 5 })).state.value).toBe(6);
    expect((await g.run({ value: 50 })).state.value).toBe(150);
  });

  it('respects maxSteps to prevent infinite loops', async () => {
    const g = new AgentGraph<{ n: number }>();
    g.addNode('loop', (ctx) => ({ n: ctx.state.n + 1 }))
     .addEdge('loop', 'loop')
     .setEntry('loop');
    const r = await g.run({ n: 0 }, { maxSteps: 5 });
    expect(r.status).toBe('maxSteps');
    expect(r.state.n).toBe(5);
  });

  it('reports unknown nodes gracefully', async () => {
    const g = new AgentGraph<{}>();
    g.addNode('start', () => {})
     .addEdge('start', 'missing')
     .setEntry('start');
    const r = await g.run({});
    expect(r.status).toBe('unknownNode');
  });

  it('describes its structure', () => {
    const g = new AgentGraph<{}>();
    g.addNode('a', () => {}).addEdge('a', 'b').setEntry('a');
    const d = g.describe();
    expect(d.entry).toBe('a');
    expect(d.nodes).toEqual(['a']);
    expect(d.edges).toHaveLength(1);
  });
});

// ──────────────────── Reflector ────────────────────
describe('v3.2 Reflector', () => {
  it('accepts good output immediately', async () => {
    const r = await reflectAndRevise('A complete sentence.', textHeuristicReflector);
    expect(r.accepted).toBe(true);
    expect(r.iterations).toBe(0);
  });

  it('revises short output and may accept the revision', async () => {
    // The reflector revises 'hi' to 'hi (could you elaborate?)' which is
    // long enough and ends with punctuation, so it may be accepted on the
    // second pass. We assert revision happened (at least one critique).
    const r = await reflectAndRevise('hi', textHeuristicReflector);
    expect(r.critiques.length).toBeGreaterThan(0);
    expect(r.iterations).toBeGreaterThan(0);
  });

  it('adds punctuation to long unpunctuated text', async () => {
    const long = 'this is a very long sentence that goes on without a period at the end yes it really does';
    const r = await reflectAndRevise(long, textHeuristicReflector);
    expect(r.output.endsWith('.')).toBe(true);
  });

  it('stops on repeating critique', async () => {
    let calls = 0;
    const stubborn = {
      critique: () => 'always wrong',
      revise: (o: string) => { calls++; return o; }
    };
    const r = await reflectAndRevise('x', stubborn, { maxIterations: 10 });
    expect(r.iterations).toBeLessThan(10);
    expect(calls).toBeLessThan(10);
  });
});

// ──────────────────── Planner ────────────────────
describe('v3.2 Planner', () => {
  it('decomposes a goal with cue words', () => {
    const p = new HeuristicPlanner();
    const steps = p.plan('first remember the date then calculate the total finally save to memory');
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0]?.id).toBe('s1');
  });

  it('infers tool hints from cue words', () => {
    const p = new HeuristicPlanner();
    const steps = p.plan('remember that the meeting is at 3pm');
    expect(steps[0]?.toolHints).toContain('memory.save');
  });

  it('respects maxSteps cap', () => {
    const p = new HeuristicPlanner();
    const steps = p.plan(Array.from({ length: 50 }, (_, i) => `step ${i}`).join(' then '), { maxSteps: 5 });
    expect(steps.length).toBeLessThanOrEqual(5);
  });

  it('buildPlan returns Plan envelope', async () => {
    const plan = await buildPlan('calculate then save');
    expect(plan.goal).toBe('calculate then save');
    expect(plan.createdAt).toBeGreaterThan(0);
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});

// ──────────────────── EmbeddingStore ────────────────────
describe('v3.2 EmbeddingStore', () => {
  it('returns top-K semantic matches', async () => {
    const store = new EmbeddingStore<{ topic: string }>();
    await store.add({ id: '1', text: 'the quick brown fox jumps over the lazy dog', meta: { topic: 'animals' } });
    await store.add({ id: '2', text: 'TypeScript is a typed superset of JavaScript', meta: { topic: 'tech' } });
    await store.add({ id: '3', text: 'a fox is a small predator related to the dog', meta: { topic: 'animals' } });

    const results = await store.search('fox dog', 2);
    expect(results.length).toBe(2);
    // Documents 1 and 3 should win over 2.
    const winningIds = results.map((r) => r.doc.id);
    expect(winningIds).not.toContain('2');
  });

  it('returns empty for empty store', async () => {
    const store = new EmbeddingStore();
    expect(await store.search('anything')).toEqual([]);
  });

  it('remove + clear work', async () => {
    const store = new EmbeddingStore();
    await store.add({ id: 'x', text: 'hello' });
    expect(store.remove('x')).toBe(true);
    expect(store.size()).toBe(0);
    await store.add({ id: 'y', text: 'world' });
    store.clear();
    expect(store.size()).toBe(0);
  });
});

// ──────────────────── CostTracker ────────────────────
describe('v3.2 CostTracker', () => {
  it('records and summarises tokens + tool calls', () => {
    const t = new CostTracker();
    t.setPriceTable({ inputPer1K: 0.001, outputPer1K: 0.002, perToolCall: 0.01 });
    t.record({ sessionId: 'S1', requestId: 'R1', tokensIn: 1000, tokensOut: 500, toolCalls: 2, labels: {} });
    t.record({ sessionId: 'S1', requestId: 'R2', tokensIn: 2000, tokensOut: 1000, toolCalls: 5, labels: {} });
    const s = t.summary();
    expect(s.records).toBe(2);
    expect(s.tokensIn).toBe(3000);
    expect(s.tokensOut).toBe(1500);
    expect(s.toolCalls).toBe(7);
    // 3*0.001 + 1.5*0.002 + 7*0.01 = 0.003 + 0.003 + 0.07 = 0.076
    expect(s.costUsd).toBeCloseTo(0.076, 4);
  });

  it('filters by session and label', () => {
    const t = new CostTracker();
    t.record({ sessionId: 'A', requestId: 'r1', tokensIn: 10, tokensOut: 5, toolCalls: 1, labels: { env: 'prod' } });
    t.record({ sessionId: 'B', requestId: 'r2', tokensIn: 20, tokensOut: 10, toolCalls: 2, labels: { env: 'dev' } });
    expect(t.summary({ sessionId: 'A' }).records).toBe(1);
    expect(t.summary({ labelKey: 'env', labelValue: 'prod' }).records).toBe(1);
  });
});

// ──────────────────── Tracer ────────────────────
describe('v3.2 Tracer', () => {
  it('starts and ends spans with valid IDs', () => {
    const tracer = new Tracer();
    const span = tracer.start('test');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    tracer.end(span.spanId);
    expect(tracer.size()).toBe(0);
    expect(tracer.finishedCount()).toBe(1);
  });

  it('children inherit traceId', () => {
    const tracer = new Tracer();
    const parent = tracer.start('parent');
    const child = tracer.start('child', { parentSpanId: parent.spanId });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    tracer.end(child.spanId);
    tracer.end(parent.spanId);
  });

  it('records events and attributes', () => {
    const tracer = new Tracer();
    const span = tracer.start('s');
    tracer.event(span.spanId, 'started');
    tracer.setAttributes(span.spanId, { user: 'alice' });
    tracer.setStatus(span.spanId, 'ok');
    tracer.end(span.spanId);
    const trace = tracer.trace(span.traceId);
    expect(trace[0]?.events[0]?.name).toBe('started');
    expect(trace[0]?.attributes.user).toBe('alice');
    expect(trace[0]?.status).toBe('ok');
  });

  it('exporters receive ended spans', () => {
    const tracer = new Tracer();
    const captured: string[] = [];
    tracer.addExporter((s) => { captured.push(s.name); });
    const a = tracer.start('a');
    tracer.end(a.spanId);
    expect(captured).toEqual(['a']);
  });
});

// ──────────────────── Retry ────────────────────
describe('v3.2 Retry', () => {
  it('succeeds on first try', async () => {
    const r = await withRetry(() => Promise.resolve('ok'));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('flaky');
      return 'good';
    }, { attempts: 5, baseMs: 1, jitter: false });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it('gives up after max attempts', async () => {
    const r = await withRetry(() => { throw new Error('always'); }, { attempts: 2, baseMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
  });

  it('retryable predicate gates retries', async () => {
    let calls = 0;
    const r = await withRetry(() => { calls++; throw new Error('not-retryable'); }, {
      attempts: 5,
      baseMs: 1,
      retryable: () => false
    });
    expect(calls).toBe(1);
    expect(r.ok).toBe(false);
  });

  it('retryNetworkErrors matches typical network failures', () => {
    expect(retryNetworkErrors(new Error('ECONNREFUSED'))).toBe(true);
    expect(retryNetworkErrors(new Error('fetch failed'))).toBe(true);
    expect(retryNetworkErrors(new Error('invalid api key'))).toBe(false);
  });
});

// ──────────────────── Crew ────────────────────
describe('v3.2 Crew', () => {
  it('runs members sequentially without supervisor', async () => {
    const crew = new Crew()
      .add({ name: 'analyst', role: 'analyse', handler: (t) => `analysed: ${t}` })
      .add({ name: 'writer', role: 'write', handler: (t) => `wrote: ${t}` });
    const r = await crew.run('publish a report');
    expect(r.status).toBe('completed');
    expect(r.turns).toHaveLength(2);
    expect(r.finalAnswer).toContain('analyst');
    expect(r.finalAnswer).toContain('writer');
  });

  it('uses a supervisor when configured', async () => {
    const crew = new Crew()
      .add({ name: 'a', role: 'x', handler: () => 'A' })
      .add({ name: 'b', role: 'y', handler: () => 'B' });
    crew.setSupervisor(roundRobinSupervisor(crew));
    const r = await crew.run('go');
    expect(r.turns.map((t) => t.agent)).toEqual(['a', 'b']);
  });

  it('isolates agent errors', async () => {
    const crew = new Crew()
      .add({ name: 'broken', role: 'x', handler: () => { throw new Error('boom'); } })
      .add({ name: 'ok', role: 'x', handler: () => 'fine' });
    const r = await crew.run('task');
    expect(r.turns[0]?.result).toContain('agent error');
    expect(r.turns[1]?.result).toBe('fine');
  });

  it('rejects duplicate agent names', () => {
    const crew = new Crew().add({ name: 'a', role: 'x', handler: () => '' });
    expect(() => crew.add({ name: 'a', role: 'y', handler: () => '' })).toThrow();
  });
});
