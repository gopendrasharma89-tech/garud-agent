import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EmbeddingStore } from '../src/embeddings/embedding-store.js';
import { HookRunner } from '../src/hooks/hook-runner.js';
import { EventBus } from '../src/core/event-bus.js';
import { HeartbeatScheduler } from '../src/heartbeat/heartbeat-scheduler.js';
import { LongTermMemory } from '../src/longterm/longterm-memory.js';
import { JsonFileStore } from '../src/storage/json-store.js';
import { CostTracker } from '../src/cost/cost-tracker.js';
import { BM25Index } from '../src/retrieval/bm25-index.js';
import { HybridRetriever } from '../src/retrieval/hybrid-retriever.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('v4.7.0 Cumulonimbus — EmbeddingStore correctness', () => {
  it('ranks correctly after vocabulary growth (regression: misaligned dense vectors)', async () => {
    const store = new EmbeddingStore();
    await store.add({ id: 'zebra', text: 'zebra stripes roam the savanna plains' });
    // Flood the vocabulary with alphabetically-earlier terms; the old dense
    // implementation shifted dimension meaning and scored the zebra doc 0.
    for (let i = 0; i < 8; i++) {
      await store.add({ id: `filler-${i}`, text: `apple banana cherry date elderberry fig grape ${i}` });
    }
    const hits = await store.search('zebra stripes savanna', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.doc.id).toBe('zebra');
  });

  it('remove() retires vocabulary contributions and re-adding does not double-count', async () => {
    const store = new EmbeddingStore();
    await store.add({ id: 'a', text: 'quantum computing qubits' });
    await store.add({ id: 'b', text: 'quantum entanglement physics' });
    expect(store.remove('a')).toBe(true);
    const hits = await store.search('quantum entanglement', 2);
    expect(hits.map((h) => h.doc.id)).toEqual(['b']);
    await store.add({ id: 'b', text: 'quantum entanglement physics' });
    expect(store.size()).toBe(1);
    const again = await store.search('entanglement', 2);
    expect(again[0]!.doc.id).toBe('b');
  });

  it('supports metadata filters', async () => {
    const store = new EmbeddingStore();
    await store.add({ id: '1', text: 'garud gateway release notes', meta: { kind: 'doc' } });
    await store.add({ id: '2', text: 'garud gateway incident report', meta: { kind: 'incident' } });
    const hits = await store.search('garud gateway', 5, { filter: (m) => m?.kind === 'incident' });
    expect(hits.map((h) => h.doc.id)).toEqual(['2']);
  });

  it('query with only unknown terms returns no results', async () => {
    const store = new EmbeddingStore();
    await store.add({ id: 'x', text: 'alpha beta gamma' });
    expect(await store.search('zzz qqq', 3)).toEqual([]);
  });

  it('custom vectorizer path still works', async () => {
    const store = new EmbeddingStore();
    store.setVectorizer((text) => (text.includes('cat') ? [1, 0] : [0, 1]));
    await store.add({ id: 'cat', text: 'cat purrs' });
    await store.add({ id: 'dog', text: 'dog barks' });
    const hits = await store.search('cat meme', 1);
    expect(hits[0]!.doc.id).toBe('cat');
  });
});

describe('v4.7.0 Cumulonimbus — hybrid retrieval filter', () => {
  it('hybrid search respects the meta filter across both systems', async () => {
    const hybrid = new HybridRetriever(new BM25Index(), new EmbeddingStore());
    await hybrid.add({ id: '1', text: 'garud agent gateway', meta: { lang: 'ts' } });
    await hybrid.add({ id: '2', text: 'garud agent tools', meta: { lang: 'py' } });
    const hits = await hybrid.search('garud agent', 5, { filter: (m) => m?.lang === 'py' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe('2');
  });
});

describe('v4.7.0 Cumulonimbus — HookRunner', () => {
  it('re-registering after unregister-all does not double-fire (regression)', async () => {
    const bus = new EventBus();
    const runner = new HookRunner(bus);
    runner.register({ name: 'h1', event: 'evt', handler: () => {} });
    runner.unregister('h1');
    let fired = 0;
    runner.register({ name: 'h2', event: 'evt', handler: () => { fired += 1; } });
    bus.emit('evt', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(1);
  });
});

describe('v4.7.0 Cumulonimbus — heartbeat dailyAt', () => {
  it('fires at the wall-clock time and reschedules day by day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 2, 8, 0, 0));
    const hs = new HeartbeatScheduler();
    let fired = 0;
    hs.schedule([{ section: 'S', rule: 'check inbox daily at 09:00' }], () => { fired += 1; });
    vi.advanceTimersByTime(60 * 60 * 1000 + 1000);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(fired).toBe(2);
    hs.stop();
    vi.advanceTimersByTime(48 * 60 * 60 * 1000);
    expect(fired).toBe(2);
  });
});

describe('v4.7.0 Cumulonimbus — LongTermMemory write serialisation', () => {
  it('concurrent appends never lose facts or race the temp file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'garud-ltm-'));
    const file = path.join(dir, 'MEMORY.md');
    const m = new LongTermMemory(file);
    await Promise.all([
      m.append('Alpha', 'fact one'),
      m.append('Alpha', 'fact two'),
      m.append('Beta', 'fact three')
    ]);
    const fresh = new LongTermMemory(file);
    expect(await fresh.factCount()).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('v4.7.0 Cumulonimbus — snapshot retention', () => {
  it('pruneSnapshots keeps the newest N', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'garud-store-'));
    const store = new JsonFileStore(dir);
    const snap = { sessions: [], memories: [] };
    await store.writeSnapshot('a', snap);
    await store.writeSnapshot('b', snap);
    await store.writeSnapshot('c', snap, { gzip: true });
    const now = Date.now();
    await utimes(path.join(dir, 'snapshots', 'a.json'), new Date(now - 3000), new Date(now - 3000));
    await utimes(path.join(dir, 'snapshots', 'b.json'), new Date(now - 2000), new Date(now - 2000));
    await utimes(path.join(dir, 'snapshots', 'c.json.gz'), new Date(now - 1000), new Date(now - 1000));
    const deleted = await store.pruneSnapshots(1);
    expect(deleted.sort()).toEqual(['a', 'b']);
    expect(await store.listSnapshots()).toEqual(['c']);
    await rm(dir, { recursive: true, force: true });
  });

  it('pruneSnapshots(0) clears all and negative keep rejects', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'garud-store-'));
    const store = new JsonFileStore(dir);
    await store.writeSnapshot('only', { sessions: [], memories: [] });
    await expect(store.pruneSnapshots(-1)).rejects.toThrow(/non-negative/);
    const deleted = await store.pruneSnapshots(0);
    expect(deleted).toEqual(['only']);
    expect(await store.listSnapshots()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('v4.7.0 Cumulonimbus — cost budgets', () => {
  it('flags exceeded limits against the global budget', () => {
    const tracker = new CostTracker();
    tracker.setPriceTable({ inputPer1K: 0.01, outputPer1K: 0.03, perToolCall: 0.001 });
    tracker.record({ sessionId: 's1', requestId: 'r1', tokensIn: 4000, tokensOut: 2000, toolCalls: 5, labels: {} });
    tracker.setBudget({ maxTokensIn: 3000, maxUsd: 0.05 });
    const status = tracker.budgetStatus();
    expect(status).toBeDefined();
    expect(status!.withinBudget).toBe(false);
    expect(status!.exceeded).toContain('maxTokensIn');
    expect(status!.exceeded).toContain('maxUsd');
  });

  it('scopes per-session budgets and supports clearBudget', () => {
    const tracker = new CostTracker();
    tracker.record({ sessionId: 'a', requestId: 'r1', tokensIn: 100, tokensOut: 0, toolCalls: 0, labels: {} });
    tracker.record({ sessionId: 'b', requestId: 'r2', tokensIn: 9000, tokensOut: 0, toolCalls: 0, labels: {} });
    tracker.setBudget({ sessionId: 'a', maxTokensIn: 500 });
    const status = tracker.budgetStatus('a');
    expect(status!.withinBudget).toBe(true);
    expect(status!.usage.tokensIn).toBe(100);
    expect(tracker.listBudgets().length).toBe(1);
    expect(tracker.clearBudget('a')).toBe(true);
    expect(tracker.budgetStatus('a')).toBeUndefined();
  });
});

describe('v4.7.0 Cumulonimbus — version', () => {
  it('reports 4.7.0 Cumulonimbus', async () => {
    const v = await import('../src/version.js');
    const s = JSON.stringify(v);
    expect(s).toContain('4.7.0');
    expect(s).toContain('Cumulonimbus');
  });
});
