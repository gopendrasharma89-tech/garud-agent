import { describe, it, expect } from 'vitest';
import { EmbeddingStore } from '../src/embeddings/embedding-store.js';
import { EmbeddingPersistence } from '../src/embeddings/embedding-persistence.js';
import { CostTracker } from '../src/cost/cost-tracker.js';
import { Tracer } from '../src/tracing/span.js';
import { HeuristicPlanner } from '../src/planning/planner.js';
import { reflectAndRevise, textHeuristicReflector } from '../src/reflection/reflector.js';
import { GARUD_VERSION, GARUD_BUILD } from '../src/version.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('v3.3 Cirrus subsystems', () => {
  it('version constants are 3.3.0 Cirrus', () => {
    expect(GARUD_VERSION).toBe('4.5.0');
    expect(GARUD_BUILD.codename).toBe('Stratocumulus');
    expect(GARUD_BUILD.releasedAt).toBe('2026-07-20');
  });

  it('EmbeddingStore.all() returns snapshot of indexed docs', async () => {
    const store = new EmbeddingStore();
    await store.add({ id: 'a', text: 'hello world' });
    await store.add({ id: 'b', text: 'goodbye moon' });
    const all = store.all();
    expect(all.length).toBe(2);
    expect(all.map((d) => d.id).sort()).toEqual(['a', 'b']);
  });

  it('EmbeddingPersistence round-trips through JSONL', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-emb-'));
    const file = path.join(dir, 'embeddings.jsonl');
    const persist = new EmbeddingPersistence(file);
    const store1 = new EmbeddingStore();
    await store1.add({ id: 'doc1', text: 'cat sat on mat' });
    await store1.add({ id: 'doc2', text: 'dog ran far' });
    const saved = await persist.save(store1, store1.all());
    expect(saved.written).toBe(2);
    expect(saved.bytes).toBeGreaterThan(0);

    const store2 = new EmbeddingStore();
    const restored = await persist.restoreInto(store2);
    expect(restored).toBe(2);
    expect(store2.size()).toBe(2);
  });

  it('CostTracker records and summarises usage', () => {
    const t = new CostTracker();
    t.setPriceTable({ inputPer1K: 1, outputPer1K: 2, perToolCall: 0.01 });
    t.record({ sessionId: 's1', requestId: 'r1', tokensIn: 1000, tokensOut: 500, toolCalls: 3, labels: {} });
    t.record({ sessionId: 's1', requestId: 'r2', tokensIn: 2000, tokensOut: 1000, toolCalls: 1, labels: {} });
    const sum = t.summary({ sessionId: 's1' });
    expect(sum.records).toBe(2);
    expect(sum.tokensIn).toBe(3000);
    expect(sum.tokensOut).toBe(1500);
    expect(sum.toolCalls).toBe(4);
    expect(sum.costUsd).toBeCloseTo(3 + 3 + 0.04, 5);
  });

  it('Tracer records spans and recent() returns finished ones', () => {
    const tr = new Tracer();
    const s1 = tr.start('op1');
    tr.end(s1);
    const s2 = tr.start('op2');
    tr.end(s2, { error: 'boom' });
    const spans = tr.recent(10);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans.find((s) => s.name === 'op1')).toBeDefined();
    expect(spans.find((s) => s.name === 'op2')).toBeDefined();
  });

  it('HeuristicPlanner accepts availableTools context', () => {
    const p = new HeuristicPlanner();
    const plan = p.plan('search the web and summarise', { availableTools: ['web.fetch', 'memory.save'], maxSteps: 5 });
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(5);
  });

  it('reflectAndRevise improves a short noisy answer', async () => {
    const result = await reflectAndRevise('error', textHeuristicReflector, { maxIterations: 2 });
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    // Either accepted after revision or stopped on repeat — output must differ from raw 'error'
    expect(result.output).not.toBe('error');
  });
});
