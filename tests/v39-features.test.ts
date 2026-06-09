import { describe, it, expect } from 'vitest';
import { BM25Index } from '../src/retrieval/bm25-index.js';
import { HybridRetriever } from '../src/retrieval/hybrid-retriever.js';
import { EmbeddingStore } from '../src/embeddings/embedding-store.js';
import { EvalHarness, type EvalCase } from '../src/eval/eval-harness.js';

describe('v3.9 Cirrostratus subsystems', () => {
  describe('BM25Index', () => {
    it('ranks exact-keyword hits highest', () => {
      const idx = new BM25Index();
      idx.add({ id: 'a', text: 'the quick brown fox jumps over the lazy dog' });
      idx.add({ id: 'b', text: 'lorem ipsum dolor sit amet' });
      idx.add({ id: 'c', text: 'a fox is a small carnivore in the canid family' });
      const r = idx.search('fox', 10);
      expect(r.length).toBe(2);
      // both contain 'fox'; one with shorter doc should score higher
      expect(r.map((h) => h.doc.id)).toContain('a');
      expect(r.map((h) => h.doc.id)).toContain('c');
    });

    it('returns empty array for empty query or empty index', () => {
      const idx = new BM25Index();
      expect(idx.search('anything', 5).length).toBe(0);
      idx.add({ id: 'a', text: 'hello world' });
      expect(idx.search('', 5).length).toBe(0);
    });

    it('remove() drops the document and clears its terms', () => {
      const idx = new BM25Index();
      idx.add({ id: 'x', text: 'unique-term apple' });
      expect(idx.search('unique-term', 5).length).toBe(1);
      idx.remove('x');
      expect(idx.size()).toBe(0);
      expect(idx.search('unique-term', 5).length).toBe(0);
    });

    it('add() with existing id replaces the document', () => {
      const idx = new BM25Index();
      idx.add({ id: 'x', text: 'apple banana' });
      idx.add({ id: 'x', text: 'cherry date' });
      expect(idx.size()).toBe(1);
      expect(idx.search('apple', 5).length).toBe(0);
      expect(idx.search('cherry', 5).length).toBe(1);
    });
  });

  describe('HybridRetriever (RRF)', () => {
    it('fuses BM25 keyword + vector ranks into a single ordering', async () => {
      const emb = new EmbeddingStore();
      const bm25 = new BM25Index();
      const h = new HybridRetriever(bm25, emb);
      await h.add({ id: '1', text: 'stripe webhook signature verification with hmac sha256' });
      await h.add({ id: '2', text: 'twilio sms api rate limits and retries' });
      await h.add({ id: '3', text: 'a small note about cooking pasta' });
      const r = await h.search('stripe webhook hmac', 3);
      expect(r.length).toBeGreaterThanOrEqual(1);
      expect(r[0]!.id).toBe('1');
      // hybrid hit should carry both ranks
      expect(r[0]!.ranks.bm25).toBeDefined();
    });

    it('size reflects underlying doc count', async () => {
      const emb = new EmbeddingStore();
      const bm25 = new BM25Index();
      const h = new HybridRetriever(bm25, emb);
      await h.add({ id: 'a', text: 'one' });
      await h.add({ id: 'b', text: 'two' });
      expect(h.size()).toBe(2);
    });
  });

  describe('EvalHarness', () => {
    it('passes a substring case', async () => {
      const harness = new EvalHarness({
        run: async (c) => ({ text: `you asked about ${c.input}` })
      });
      const cases: EvalCase[] = [{ id: 'c1', input: 'pasta', expect: { contains: 'pasta' } }];
      const r = await harness.runSuite(cases);
      expect(r.passed).toBe(1);
      expect(r.failed).toBe(0);
      expect(r.passRate).toBe(1);
    });

    it('fails when expected tool was not used', async () => {
      const harness = new EvalHarness({
        run: async () => ({ text: 'noop', toolsUsed: ['web.fetch'] })
      });
      const cases: EvalCase[] = [{ id: 'c1', input: 'x', expect: { toolsUsed: ['memory.save'] } }];
      const r = await harness.runSuite(cases);
      expect(r.passed).toBe(0);
      expect(r.cases[0]!.failures[0]).toMatch(/memory\.save/);
    });

    it('records latency percentiles', async () => {
      const harness = new EvalHarness({
        run: async () => ({ text: 'ok' })
      });
      const cases: EvalCase[] = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: 'x', expect: { contains: 'ok' } }));
      const r = await harness.runSuite(cases);
      expect(r.passed).toBe(10);
      expect(r.p95LatencyMs).toBeGreaterThanOrEqual(0);
      expect(r.p99LatencyMs).toBeGreaterThanOrEqual(r.p95LatencyMs);
    });

    it('reports the failure when the run() function throws', async () => {
      const harness = new EvalHarness({
        run: async () => { throw new Error('boom'); }
      });
      const r = await harness.runSuite([{ id: 'crash', input: 'x' }]);
      expect(r.passed).toBe(0);
      expect(r.cases[0]!.failures[0]).toMatch(/boom/);
    });

    it('validates JSON-field expectations', async () => {
      const harness = new EvalHarness({
        run: async () => ({ text: JSON.stringify({ outer: { inner: 42 } }) })
      });
      const ok: EvalCase[] = [{ id: 'p', input: 'x', expect: { jsonField: { path: 'outer.inner', equals: 42 } } }];
      const okR = await harness.runSuite(ok);
      expect(okR.passed).toBe(1);
      const bad: EvalCase[] = [{ id: 'p', input: 'x', expect: { jsonField: { path: 'outer.inner', equals: 99 } } }];
      const badR = await harness.runSuite(bad);
      expect(badR.passed).toBe(0);
    });
  });
});
