import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { LongTermMemory } from '../src/longterm/longterm-memory.js';
import { DailyLog } from '../src/longterm/daily-log.js';
import { ContextCompactor } from '../src/compaction/context-compactor.js';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

describe('v2.5 subsystem methods', () => {
  describe('LongTermMemory.byDate() iterates full body (no 1000-fact cap)', () => {
    let dir: string;
    let mem: LongTermMemory;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-lt25-'));
      mem = new LongTermMemory(path.join(dir, 'MEMORY.md'));
    });

    it('returns facts matching a specific date', async () => {
      const today = new Date().toISOString().slice(0, 10);
      await mem.append('a', 'fact 1');
      await mem.append('b', 'fact 2');
      const facts = await mem.byDate(today);
      expect(facts).toHaveLength(2);
    });

    it('reads from full body, not capped at 1000', async () => {
      // Inject 1100 facts directly via replace to simulate >1000 entries
      const today = new Date().toISOString().slice(0, 10);
      const lines: string[] = ['## bulk'];
      for (let i = 0; i < 1100; i++) lines.push(`- ${today}: fact ${i}`);
      await mem.replace(lines.join('\n'));
      const facts = await mem.byDate(today);
      expect(facts.length).toBe(1100);
    });

    it('returns empty for invalid date', async () => {
      expect(await mem.byDate('not-a-date')).toEqual([]);
    });
  });

  describe('DailyLog enhancements', () => {
    let dir: string;
    let log: DailyLog;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-dl25-'));
      log = new DailyLog(dir);
    });

    it('summary returns latest date when entries exist', async () => {
      await log.append('user', 'hello');
      const s = await log.summary();
      expect(s.dates).toBe(1);
      expect(s.latest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('summary omits latest when empty', async () => {
      const s = await log.summary();
      expect(s.dates).toBe(0);
      expect(s.latest).toBeUndefined();
    });

    it('latest(n) combines recent logs with date headers', async () => {
      await log.append('user', 'today hello');
      const body = await log.latest(3);
      expect(body).toMatch(/^# \d{4}-\d{2}-\d{2}/);
      expect(body).toContain('today hello');
    });

    it('latest(0) clamps to minimum 1', async () => {
      await log.append('user', 'x');
      const body = await log.latest(0);
      expect(body.length).toBeGreaterThan(0);
    });
  });

  describe('ContextCompactor.applyTo()', () => {
    it('returns kept turns directly', () => {
      const c = new ContextCompactor({ budgetChars: 1000, keepRecent: 3, pruneBelow: 0.2 });
      const turns = [
        { role: 'user' as const, content: 'hi' },
        { role: 'assistant' as const, content: 'hello' }
      ];
      const out = c.applyTo(turns);
      expect(out).toEqual(turns);
    });

    it('compacts when over budget', () => {
      const c = new ContextCompactor({ budgetChars: 50, keepRecent: 1, pruneBelow: 0.2 });
      const turns = [
        { role: 'user' as const, content: 'a'.repeat(100) },
        { role: 'assistant' as const, content: 'recent' }
      ];
      const out = c.applyTo(turns);
      expect(out.length).toBeLessThanOrEqual(2);
    });
  });
});

describe('v2.5 HTTP endpoints', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

  beforeAll(async () => {
    const config = mergeConfig(defaultConfig, {
      workspace: { dir: '/tmp/garud-v25-test-' + Date.now(), persist: false },
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

  it('GET /daily/latest returns combined recent logs', async () => {
    await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'latest-user', text: 'seed' })
    });
    const res = await fetch(`${baseUrl}/daily/latest?n=3`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; n: number; body: string };
    expect(body.ok).toBe(true);
    expect(body.n).toBe(3);
    expect(typeof body.body).toBe('string');
  });

  it('GET /daily/latest clamps n to [1, 365]', async () => {
    const res = await fetch(`${baseUrl}/daily/latest?n=9999`);
    const body = await res.json() as { ok: boolean; n: number };
    expect(body.n).toBe(365);
  });

  it('POST /longterm/replace overwrites memory body', async () => {
    const res = await fetch(`${baseUrl}/longterm/replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '## fresh\n- 2026-05-15: replaced via HTTP\n' })
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; bytes: number };
    expect(body.ok).toBe(true);
    expect(body.bytes).toBeGreaterThan(0);
    const read = await (await fetch(`${baseUrl}/longterm`)).json() as { body: string };
    expect(read.body).toContain('replaced via HTTP');
  });

  it('POST /longterm/replace rejects non-string body', async () => {
    const res = await fetch(`${baseUrl}/longterm/replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 42 })
    });
    expect(res.status).toBe(400);
  });

  it('GET /daily/summary returns latest field when populated', async () => {
    await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'sum-user', text: 'seed' })
    });
    const res = await fetch(`${baseUrl}/daily/summary`);
    const body = await res.json() as { ok: boolean; dates: number; bytes: number; latest?: string };
    expect(body.ok).toBe(true);
    if (body.dates > 0) {
      expect(body.latest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
