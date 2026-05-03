import { describe, expect, it } from 'vitest';
import { ToolCache } from '../src/cache/tool-cache.js';

describe('ToolCache', () => {
  it('returns undefined on cache miss and increments misses', () => {
    const cache = new ToolCache({ enabled: true, ttlMs: 1000 });
    expect(cache.get('echo', 'hi')).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it('hits when same key is set then read', () => {
    const cache = new ToolCache({ enabled: true, ttlMs: 1000 });
    cache.set('echo', 'hi', { content: 'hi' });
    const hit = cache.get('echo', 'hi');
    expect(hit?.content).toBe('hi');
    expect(cache.stats().hits).toBe(1);
  });

  it('expires entries after TTL', () => {
    let now = 0;
    const cache = new ToolCache({ enabled: true, ttlMs: 100 });
    cache.setTimeProvider(() => now);
    cache.set('echo', 'hi', { content: 'hi' });
    now += 200;
    expect(cache.get('echo', 'hi')).toBeUndefined();
  });

  it('does not cache error results', () => {
    const cache = new ToolCache({ enabled: true, ttlMs: 1000 });
    cache.set('bad', 'x', { content: 'oops', error: true });
    expect(cache.get('bad', 'x')).toBeUndefined();
  });

  it('honours enabled=false', () => {
    const cache = new ToolCache({ enabled: false });
    cache.set('echo', 'hi', { content: 'hi' });
    expect(cache.get('echo', 'hi')).toBeUndefined();
  });

  it('evicts least-recently-used entries beyond maxEntries', () => {
    const cache = new ToolCache({ enabled: true, ttlMs: 60_000, maxEntries: 2 });
    cache.set('echo', 'a', { content: 'A' });
    cache.set('echo', 'b', { content: 'B' });
    cache.set('echo', 'c', { content: 'C' });
    expect(cache.get('echo', 'a')).toBeUndefined();
    expect(cache.get('echo', 'b')?.content).toBe('B');
    expect(cache.get('echo', 'c')?.content).toBe('C');
  });

  it('clear resets stats and size', () => {
    const cache = new ToolCache({ enabled: true, ttlMs: 60_000 });
    cache.set('echo', 'a', { content: 'A' });
    cache.get('echo', 'a');
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.stats().hits).toBe(0);
  });

  it('refreshes LRU position on hit', () => {
    const cache = new ToolCache({ enabled: true, ttlMs: 60_000, maxEntries: 2 });
    cache.set('echo', 'a', { content: 'A' });
    cache.set('echo', 'b', { content: 'B' });
    // touch 'a' so it becomes most recent
    cache.get('echo', 'a');
    cache.set('echo', 'c', { content: 'C' });
    expect(cache.get('echo', 'a')?.content).toBe('A');
    expect(cache.get('echo', 'b')).toBeUndefined();
  });
});
