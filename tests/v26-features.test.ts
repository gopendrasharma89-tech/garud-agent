import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { LongTermMemory } from '../src/longterm/longterm-memory.js';
import { ContextCompactor } from '../src/compaction/context-compactor.js';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

describe('v2.6 subsystem methods', () => {
  describe('LongTermMemory.replace size cap', () => {
    let dir: string;
    let mem: LongTermMemory;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-lt26-'));
      mem = new LongTermMemory(path.join(dir, 'MEMORY.md'));
    });

    it('accepts bodies under 5 MiB', async () => {
      await mem.replace('## hello\n- 2026-05-16: small');
      expect(await mem.read()).toContain('hello');
    });

    it('rejects bodies above 5 MiB', async () => {
      const huge = 'x'.repeat(6 * 1024 * 1024);
      await expect(mem.replace(huge)).rejects.toThrow(/too large/);
    });
  });

  describe('ContextCompactor metrics', () => {
    it('size() returns total character count', () => {
      const c = new ContextCompactor();
      const turns = [
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'world' }
      ];
      expect(c.size(turns)).toBe(10);
    });

    it('needsCompaction returns false below budget', () => {
      const c = new ContextCompactor({ budgetChars: 1000, keepRecent: 3, pruneBelow: 0.2 });
      expect(c.needsCompaction([{ role: 'user', content: 'hi' }])).toBe(false);
    });

    it('needsCompaction returns true above budget', () => {
      const c = new ContextCompactor({ budgetChars: 5, keepRecent: 1, pruneBelow: 0.2 });
      expect(c.needsCompaction([{ role: 'user', content: 'long-content' }])).toBe(true);
    });
  });
});

describe('v2.6 HTTP endpoints', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

  beforeAll(async () => {
    const config = mergeConfig(defaultConfig, {
      workspace: { dir: '/tmp/garud-v26-test-' + Date.now(), persist: false },
      authToken: undefined,
      dashboard: { enabled: true },
      metrics: { enabled: true }
    });
    bootstrapResult = await bootstrap(config);
    server = createServer({
      gateway: bootstrapResult.gateway,
      config,
      tools: bootstrapResult.tools,
      metrics: bootstrapResult.metrics,
      longterm: bootstrapResult.longterm,
      dailyLog: bootstrapResult.dailyLog,
      subagent: bootstrapResult.subagent,
      nodes: bootstrapResult.nodes,
      hooks: bootstrapResult.hooks
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await bootstrapResult.scheduler?.stop();
  });

  it('GET /audit/kinds returns distinct kinds (after activity)', async () => {
    await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'audit-user', text: 'seed' })
    });
    const res = await fetch(`${baseUrl}/audit/kinds`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; kinds: string[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.kinds)).toBe(true);
    expect(body.kinds.length).toBeGreaterThan(0);
  });

  it('GET /audit/count returns counter per kind', async () => {
    const res = await fetch(`${baseUrl}/audit/count`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; counts: Record<string, number> };
    expect(body.ok).toBe(true);
    expect(typeof body.counts).toBe('object');
  });

  it('POST /longterm/replace rejects oversized body with 413', async () => {
    // Use server payload-cap (6 MiB readJson budget) — the server destroys the
    // socket beyond that, so we stay within the cap and exceed the LongTermMemory
    // 5 MiB body limit instead, which yields a clean 413 response.
    const justOver5MiB = 'x'.repeat(5 * 1024 * 1024 + 1024);
    const res = await fetch(`${baseUrl}/longterm/replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: justOver5MiB })
    });
    expect(res.status).toBe(413);
  });

  it('POST /longterm/replace accepts normal bodies', async () => {
    const res = await fetch(`${baseUrl}/longterm/replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '## test\n- 2026-05-16: ok\n' })
    });
    expect(res.status).toBe(200);
  });
});
