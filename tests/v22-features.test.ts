import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { LongTermMemory } from '../src/longterm/longterm-memory.js';
import { NodeRegistry } from '../src/nodes/node-registry.js';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

describe('v2.2 subsystem methods', () => {
  describe('LongTermMemory.sections()', () => {
    let dir: string;
    let mem: LongTermMemory;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-lt22-'));
      mem = new LongTermMemory(path.join(dir, 'MEMORY.md'));
    });

    it('returns empty for empty memory', async () => {
      expect(await mem.sections()).toEqual([]);
    });

    it('lists section names in file order', async () => {
      await mem.append('first', 'a');
      await mem.append('second', 'b');
      await mem.append('third', 'c');
      const list = await mem.sections();
      expect(list).toEqual(['first', 'second', 'third']);
    });

    it('does not duplicate names when same section reused', async () => {
      await mem.append('skills', 'Python');
      await mem.append('skills', 'TypeScript');
      const list = await mem.sections();
      expect(list).toEqual(['skills']);
    });
  });

  describe('NodeRegistry.stats() and idle()', () => {
    it('stats() counts nodes and invocations by status', () => {
      const reg = new NodeRegistry();
      const n1 = reg.register({ name: 'a', platform: 'linux', capabilities: ['x'] });
      reg.register({ name: 'b', platform: 'macos', capabilities: ['y'] });
      const inv = reg.invoke(n1.id, 'x', {});
      reg.resolve(inv.id, { ok: true });
      reg.invoke(n1.id, 'x', {});
      const s = reg.stats();
      expect(s.nodes).toBe(2);
      expect(s.invocations.total).toBe(2);
      expect(s.invocations.done).toBe(1);
      expect(s.invocations.pending).toBe(1);
    });

    it('idle() returns nodes not recently seen', async () => {
      const reg = new NodeRegistry();
      const n = reg.register({ name: 'stale', platform: 'headless', capabilities: [] });
      // Fake lastSeenAt to long ago
      (reg.get(n.id) as { lastSeenAt: number }).lastSeenAt = Date.now() - 10_000;
      expect(reg.idle(5_000)).toHaveLength(1);
      expect(reg.idle(20_000)).toHaveLength(0);
    });
  });

  describe('SubAgentRunner.stats()', () => {
    it('counts jobs by status', async () => {
      const { SubAgentRunner } = await import('../src/subagent/subagent-runner.js');
      const stubRuntime = { reply: async () => ({ text: 'done', toolUses: [] }) } as unknown as ConstructorParameters<typeof SubAgentRunner>[0];
      const runner = new SubAgentRunner(stubRuntime, 4);
      const session = {
        id: 's', channel: 'http', userId: 'u', trustLevel: 'owner' as const,
        role: 'main' as const, agentId: 'a', createdAt: 0, updatedAt: 0,
        messageCount: 0, settings: {}
      };
      runner.spawn('task1', session);
      runner.spawn('task2', session);
      const s = runner.stats();
      expect(s.total).toBe(2);
    });
  });
});

describe('v2.2 HTTP endpoints', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

  beforeAll(async () => {
    const config = mergeConfig(defaultConfig, {
      workspace: { dir: '/tmp/garud-v22-test-' + Date.now(), persist: false },
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

  it('/longterm returns memory state', async () => {
    const res = await fetch(`${baseUrl}/longterm`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; bytes: number; facts: number; sections: string[] };
    expect(body.ok).toBe(true);
    expect(typeof body.bytes).toBe('number');
    expect(typeof body.facts).toBe('number');
    expect(Array.isArray(body.sections)).toBe(true);
  });

  it('/longterm/stats returns summary', async () => {
    await bootstrapResult.longterm.append('test', 'a fact');
    const res = await fetch(`${baseUrl}/longterm/stats`);
    const body = await res.json() as { ok: boolean; bytes: number; facts: number; sections: number };
    expect(body.ok).toBe(true);
    expect(body.facts).toBeGreaterThan(0);
    expect(body.sections).toBeGreaterThan(0);
  });

  it('/longterm/section/:name returns section body', async () => {
    await bootstrapResult.longterm.append('demo', 'demo fact');
    const res = await fetch(`${baseUrl}/longterm/section/demo`);
    const body = await res.json() as { ok: boolean; section: string; body: string };
    expect(body.ok).toBe(true);
    expect(body.section).toBe('demo');
    expect(body.body).toContain('demo fact');
  });

  it('/sub-agents returns list and stats', async () => {
    const res = await fetch(`${baseUrl}/sub-agents`);
    const body = await res.json() as { ok: boolean; jobs: unknown[]; stats: { total: number } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(typeof body.stats.total).toBe('number');
  });

  it('/nodes returns node list', async () => {
    bootstrapResult.nodes.register({ name: 'test-node', platform: 'linux', capabilities: ['exec'] });
    const res = await fetch(`${baseUrl}/nodes`);
    const body = await res.json() as { ok: boolean; nodes: Array<{ name: string }>; stats: { nodes: number } };
    expect(body.ok).toBe(true);
    expect(body.nodes.find((n) => n.name === 'test-node')).toBeDefined();
    expect(body.stats.nodes).toBeGreaterThan(0);
  });

  it('/nodes/invocations returns recent invocations', async () => {
    const res = await fetch(`${baseUrl}/nodes/invocations?limit=10`);
    const body = await res.json() as { ok: boolean; invocations: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.invocations)).toBe(true);
  });

  it('/hooks returns hook list', async () => {
    const res = await fetch(`${baseUrl}/hooks`);
    const body = await res.json() as { ok: boolean; hooks: unknown[]; size: number };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.hooks)).toBe(true);
    expect(typeof body.size).toBe('number');
  });
});
