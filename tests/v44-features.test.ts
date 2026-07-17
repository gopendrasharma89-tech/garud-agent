import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ToolCache } from '../src/cache/tool-cache.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { ToolQuotaManager } from '../src/quotas/tool-quota.js';
import { ContextCompactor } from '../src/compaction/context-compactor.js';
import { MemoryIndex } from '../src/memory/memory-index.js';
import { CronScheduler } from '../src/scheduler/cron.js';
import { GARUD_VERSION, GARUD_BUILD } from '../src/version.js';

describe('v4.4.0 "Altocumulus"', () => {
  it('reports version 4.4.0 Altocumulus', () => {
    expect(GARUD_VERSION).toBe('4.4.0');
    expect(GARUD_BUILD.codename).toBe('Altocumulus');
  });

  it('ToolCache: refreshing an entry updates its LRU position', () => {
    const cache = new ToolCache({ enabled: true, ttlMs: 10_000, maxEntries: 2 });
    cache.set('a', 'x', { content: '1' });
    cache.set('b', 'x', { content: '2' });
    cache.set('a', 'x', { content: '1-refreshed' }); // b is now oldest
    cache.set('c', 'x', { content: '3' }); // evicts b, not a
    expect(cache.get('a', 'x')?.content).toBe('1-refreshed');
    expect(cache.get('b', 'x')).toBeUndefined();
    expect(cache.get('c', 'x')?.content).toBe('3');
  });

  it('ToolCache: drops expired entries before evicting live ones', () => {
    let now = 0;
    const cache = new ToolCache({ enabled: true, ttlMs: 100, maxEntries: 2 });
    cache.setTimeProvider(() => now);
    cache.set('a', 'x', { content: '1' }); // expires at 100
    now = 40;
    cache.set('b', 'x', { content: '2' }); // expires at 140
    cache.get('a', 'x'); // moves expired-soon 'a' to most-recent position
    now = 120; // 'a' expired, 'b' still live
    cache.set('c', 'x', { content: '3' });
    expect(cache.get('b', 'x')?.content).toBe('2');
    expect(cache.get('c', 'x')?.content).toBe('3');
    expect(cache.size()).toBe(2);
  });

  it('RateLimiter.prune removes only expired buckets', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 100, maxRequests: 5 });
    limiter.setTimeProvider(() => now);
    limiter.allow('s1');
    limiter.allow('s2');
    now = 50;
    limiter.allow('s3');
    now = 120; // s1, s2 expired; s3 alive
    expect(limiter.prune()).toBe(2);
    expect(limiter.size()).toBe(1);
  });

  it('RateLimiter auto-prunes at pruneThreshold', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 100, maxRequests: 5, pruneThreshold: 3 });
    limiter.setTimeProvider(() => now);
    limiter.allow('a');
    limiter.allow('b');
    limiter.allow('c');
    now = 200; // all expired
    limiter.allow('d'); // hits threshold, prunes stale buckets first
    expect(limiter.size()).toBe(1);
  });

  it('ToolQuotaManager.prune removes expired buckets', () => {
    let now = 0;
    const quota = new ToolQuotaManager({ defaultLimit: 5, windowMs: 100 });
    quota.setTimeProvider(() => now);
    quota.consume('s1', 'echo');
    quota.consume('s2', 'echo');
    now = 150;
    expect(quota.prune()).toBe(2);
    expect(quota.size()).toBe(0);
  });

  it('ToolQuotaManager.reset handles session ids containing ::', () => {
    const quota = new ToolQuotaManager({ defaultLimit: 5 });
    quota.consume('user::web', 'echo');
    quota.consume('other', 'echo');
    quota.reset('user::web');
    expect(quota.size()).toBe(1);
    quota.reset(undefined, 'echo');
    expect(quota.size()).toBe(0);
  });

  it('ContextCompactor: keepRecent=0 keeps only the summary', () => {
    const compactor = new ContextCompactor({ budgetChars: 10, keepRecent: 0, pruneBelow: 0.2 });
    const turns = [
      { role: 'user' as const, content: 'please remember my favourite colour is teal' },
      { role: 'assistant' as const, content: 'Noted — I will remember that your favourite colour is teal.' }
    ];
    const plan = compactor.plan(turns);
    expect(plan.kept.length).toBe(1);
    expect(plan.kept[0].role).toBe('system');
    expect(plan.kept[0].content).toContain('summary');
  });

  it('MemoryIndex.searchTopics finds the relevant topic via BM25', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-mem-'));
    try {
      const mem = new MemoryIndex(dir);
      await mem.saveTopic('deploy', 'We deploy with docker compose on the staging server every friday.');
      await mem.saveTopic('food', 'Favourite lunch spots near the office include the dosa cart.');
      const results = await mem.searchTopics('docker deploy staging', 2);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].topic).toBe('deploy');
      expect(results[0].snippet).toContain('docker');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('CronScheduler: runOnStart fires the job immediately', async () => {
    const cron = new CronScheduler();
    let runs = 0;
    cron.add({ id: 'boot', interval: 60_000, runOnStart: true, task: () => { runs += 1; } });
    cron.start();
    await new Promise((r) => setTimeout(r, 25));
    expect(runs).toBe(1);
    cron.stop();
  });
});
