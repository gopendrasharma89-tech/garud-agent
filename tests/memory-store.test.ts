import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/core/memory-store.js';

describe('MemoryStore', () => {
  it('saves and lists memories per session', () => {
    const store = new MemoryStore();
    store.save('s1', 'one', ['a']);
    store.save('s1', 'two', ['b']);
    store.save('s2', 'other', ['c']);
    expect(store.list('s1')).toHaveLength(2);
    expect(store.list('s2')).toHaveLength(1);
  });

  it('rejects empty memory text', () => {
    const store = new MemoryStore();
    expect(() => store.save('s1', '   ')).toThrow();
  });

  it('clamps importance into [0, 1]', () => {
    const store = new MemoryStore();
    const m = store.save('s1', 'hello', [], 5);
    expect(m.importance).toBe(1);
    const n = store.save('s1', 'hello2', [], -2);
    expect(n.importance).toBe(0);
  });

  it('returns memories ranked by relevance and importance', () => {
    const store = new MemoryStore();
    let t = 1000;
    store.setTimeProvider(() => t);
    store.save('s1', 'project alpha uses rust workers', ['project'], 0.6);
    t += 1000;
    store.save('s1', 'project alpha launches monday', ['launch'], 0.95);
    const results = store.search('s1', 'alpha launches', 2);
    expect(results[0]?.text).toContain('launches');
  });

  it('removes memories by id', () => {
    const store = new MemoryStore();
    const m = store.save('s1', 'remove me');
    expect(store.remove(m.id)).toBe(true);
    expect(store.remove(m.id)).toBe(false);
    expect(store.list('s1')).toHaveLength(0);
  });

  it('evicts oldest unpinned when over capacity', () => {
    const store = new MemoryStore({ maxPerSession: 2 });
    store.save('s1', 'one');
    store.save('s1', 'two');
    store.save('s1', 'three');
    const list = store.list('s1');
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.text).sort()).toEqual(['three', 'two']);
  });

  it('treats maxPerSession=0 as unlimited', () => {
    const store = new MemoryStore({ maxPerSession: 0 });
    for (let i = 0; i < 50; i++) store.save('s1', `note-${i}`);
    expect(store.list('s1')).toHaveLength(50);
  });

  it('hydrates from a snapshot', () => {
    const store = new MemoryStore();
    store.hydrate([
      { id: 'a', sessionId: 's1', text: 'restored', tags: [], importance: 0.5, createdAt: 1 }
    ]);
    expect(store.list('s1')).toHaveLength(1);
    expect(store.get('a')?.text).toBe('restored');
  });

  it('searchWithScores filters by tag', () => {
    const store = new MemoryStore();
    store.save('s1', 'apple', ['fruit']);
    store.save('s1', 'carrot', ['veg']);
    const results = store.searchWithScores('s1', 'apple', { tags: ['fruit'], limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.memory.text).toBe('apple');
  });

  it('searchWithScores fuzzy mode boosts ngram matches', () => {
    const store = new MemoryStore();
    store.save('s1', 'configuration', [], 0.5);
    store.save('s1', 'unrelated thing', [], 0.5);
    const results = store.searchWithScores('s1', 'configuratoin', { fuzzy: true, limit: 2 });
    expect(results[0]?.memory.text).toBe('configuration');
  });

  it('searchAll spans every session', () => {
    const store = new MemoryStore();
    store.save('s1', 'alpha launch', [], 0.8);
    store.save('s2', 'alpha rollout', [], 0.6);
    const results = store.searchAll('alpha', 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('importMemories validates fields', () => {
    const store = new MemoryStore();
    const inserted = store.importMemories([
      { id: 'm1', sessionId: 's1', text: 'good', tags: [], importance: 0.5, createdAt: 1 },
      { id: 'm2', sessionId: 's1', text: '', tags: [], importance: 0.5, createdAt: 1 },
      null,
      { id: 'm3', sessionId: 's1' },
      'not an object'
    ] as never[]);
    expect(inserted).toBe(1);
  });

  it('importMemories skips duplicates by default', () => {
    const store = new MemoryStore();
    const seed = store.save('s1', 'seed');
    const inserted = store.importMemories([
      seed,
      { id: 'm-new', sessionId: 's1', text: 'fresh', tags: [], importance: 0.4, createdAt: 1 }
    ]);
    expect(inserted).toBe(1);
    expect(store.list('s1')).toHaveLength(2);
  });

  it('clearSession removes only that session', () => {
    const store = new MemoryStore();
    store.save('s1', 'one');
    store.save('s1', 'two');
    store.save('s2', 'other');
    expect(store.clearSession('s1')).toBe(2);
    expect(store.list('s1')).toHaveLength(0);
    expect(store.list('s2')).toHaveLength(1);
  });

  it('reports total size', () => {
    const store = new MemoryStore();
    store.save('s1', 'one');
    store.save('s2', 'two');
    expect(store.size()).toBe(2);
  });

  it('searchWithScores sorts by score even without overlap', () => {
    const store = new MemoryStore();
    store.save('s1', 'apple', [], 0.1);
    store.save('s1', 'banana', [], 0.9);
    const results = store.searchWithScores('s1', 'unrelated', { limit: 5 });
    expect(results[0]?.memory.text).toBe('banana');
  });

  it('pinned memories survive eviction pressure', () => {
    const store = new MemoryStore({ maxPerSession: 2 });
    const pinned = store.save('s1', 'critical', { pinned: true, importance: 1 });
    store.save('s1', 'one');
    store.save('s1', 'two');
    store.save('s1', 'three');
    expect(store.get(pinned.id)?.text).toBe('critical');
  });

  it('expires memories with TTL', () => {
    let now = 1000;
    const store = new MemoryStore();
    store.setTimeProvider(() => now);
    store.save('s1', 'ephemeral', { ttlMs: 500 });
    expect(store.list('s1')).toHaveLength(1);
    now += 1000;
    expect(store.list('s1')).toHaveLength(0);
  });

  it('pruneExpired drops expired entries', () => {
    let now = 0;
    const store = new MemoryStore();
    store.setTimeProvider(() => now);
    store.save('s1', 'short', { ttlMs: 100 });
    store.save('s1', 'long', { ttlMs: 10_000 });
    now += 500;
    expect(store.pruneExpired()).toBe(1);
    expect(store.list('s1', true)).toHaveLength(1);
  });

  it('pin/unpin toggles flag', () => {
    const store = new MemoryStore();
    const m = store.save('s1', 'note');
    expect(store.pin(m.id, true)?.pinned).toBe(true);
    expect(store.pin(m.id, false)?.pinned).toBe(false);
    expect(store.pin('missing', true)).toBeUndefined();
  });

  it('dedup near-duplicates when threshold > 0', () => {
    const store = new MemoryStore({ dedupThreshold: 0.5 });
    const a = store.save('s1', 'meeting at five pm');
    const b = store.save('s1', 'meeting at five pm tomorrow');
    expect(b.id).toBe(a.id);
    expect(store.list('s1')).toHaveLength(1);
  });
});
