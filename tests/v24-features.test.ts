import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { LongTermMemory } from '../src/longterm/longterm-memory.js';
import { DailyLog } from '../src/longterm/daily-log.js';
import { HookRunner } from '../src/hooks/hook-runner.js';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

describe('v2.4 subsystem methods', () => {
  describe('LongTermMemory.byDate()', () => {
    let dir: string;
    let mem: LongTermMemory;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-lt24-'));
      mem = new LongTermMemory(path.join(dir, 'MEMORY.md'));
    });

    it('returns empty for missing date', async () => {
      expect(await mem.byDate('1999-01-01')).toEqual([]);
    });

    it('returns empty for invalid date format', async () => {
      expect(await mem.byDate('not-a-date')).toEqual([]);
      expect(await mem.byDate('2026-5-1')).toEqual([]);
    });

    it('returns facts for today after append', async () => {
      await mem.append('demo', 'today fact');
      const today = new Date().toISOString().slice(0, 10);
      const facts = await mem.byDate(today);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.fact).toBe('today fact');
      expect(facts[0]?.section).toBe('demo');
    });
  });

  describe('DailyLog.summary()', () => {
    let dir: string;
    let log: DailyLog;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-dl24-'));
      log = new DailyLog(dir);
    });

    it('returns zeroes for empty directory', async () => {
      const s = await log.summary();
      expect(s.dates).toBe(0);
      expect(s.bytes).toBe(0);
    });

    it('returns dates count and byte size after writes', async () => {
      await log.append('user', 'hi');
      await log.append('assistant', 'hello');
      const s = await log.summary();
      expect(s.dates).toBe(1);
      expect(s.bytes).toBeGreaterThan(0);
    });
  });

  describe('HookRunner.byEvent()', () => {
    it('returns hooks registered for a specific event', () => {
      const bus = { on: () => undefined };
      const runner = new HookRunner(bus);
      runner.register({ name: 'h1', event: 'a', handler: () => {} });
      runner.register({ name: 'h2', event: 'a', handler: () => {} });
      runner.register({ name: 'h3', event: 'b', handler: () => {} });
      const aHooks = runner.byEvent('a');
      expect(aHooks).toHaveLength(2);
      expect(aHooks.map((h) => h.name).sort()).toEqual(['h1', 'h2']);
      expect(runner.byEvent('b')).toHaveLength(1);
      expect(runner.byEvent('missing')).toEqual([]);
    });

    it('reports fire/error counters per hook', async () => {
      const subs: Array<(p: unknown) => void> = [];
      const bus = { on: (_e: string, cb: (p: unknown) => void) => { subs.push(cb); return undefined; } };
      const runner = new HookRunner(bus);
      runner.register({ name: 'h', event: 'x', handler: () => {} });
      subs[0]!({});
      subs[0]!({});
      await new Promise((r) => setTimeout(r, 10));
      const hooks = runner.byEvent('x');
      expect(hooks[0]?.fired).toBe(2);
      expect(hooks[0]?.errors).toBe(0);
    });
  });
});

describe('v2.4 HTTP endpoints', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

  beforeAll(async () => {
    const config = mergeConfig(defaultConfig, {
      workspace: { dir: '/tmp/garud-v24-test-' + Date.now(), persist: false },
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

  it('GET /longterm/by-date/:date returns facts for that day', async () => {
    await bootstrapResult.longterm.append('test', 'v2.4 fact');
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(`${baseUrl}/longterm/by-date/${today}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; date: string; facts: Array<{ section: string; fact: string }> };
    expect(body.ok).toBe(true);
    expect(body.date).toBe(today);
    expect(body.facts.some((f) => f.fact === 'v2.4 fact')).toBe(true);
  });

  it('GET /daily returns todays log body', async () => {
    // Send a message to trigger daily-log hook
    await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'daily-user', text: 'hello daily' })
    });
    const res = await fetch(`${baseUrl}/daily`);
    const body = await res.json() as { ok: boolean; date: string; body: string };
    expect(body.ok).toBe(true);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.body.length).toBeGreaterThan(0);
  });

  it('GET /daily rejects invalid date format', async () => {
    const res = await fetch(`${baseUrl}/daily?date=not-a-date`);
    expect(res.status).toBe(400);
  });

  it('GET /daily/dates returns sorted dates', async () => {
    const res = await fetch(`${baseUrl}/daily/dates`);
    const body = await res.json() as { ok: boolean; dates: string[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.dates)).toBe(true);
  });

  it('GET /daily/summary returns dates + bytes', async () => {
    const res = await fetch(`${baseUrl}/daily/summary`);
    const body = await res.json() as { ok: boolean; dates: number; bytes: number };
    expect(body.ok).toBe(true);
    expect(typeof body.dates).toBe('number');
    expect(typeof body.bytes).toBe('number');
  });

  it('GET /hooks/event/:event returns hooks for event', async () => {
    const res = await fetch(`${baseUrl}/hooks/event/received`);
    const body = await res.json() as { ok: boolean; event: string; hooks: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.event).toBe('received');
    expect(Array.isArray(body.hooks)).toBe(true);
  });

  it('POST /sub-agents/prune validates olderThanMs', async () => {
    const res = await fetch(`${baseUrl}/sub-agents/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ olderThanMs: -1 })
    });
    expect(res.status).toBe(400);
  });

  it('POST /nodes/:id/invoke validates timeoutMs', async () => {
    const node = bootstrapResult.nodes.register({ name: 'tv', platform: 'linux', capabilities: ['x'] });
    const res = await fetch(`${baseUrl}/nodes/${node.id}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'x', timeoutMs: -100 })
    });
    expect(res.status).toBe(400);
  });
});
