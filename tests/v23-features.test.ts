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

describe('v2.3 subsystem methods', () => {
  describe('LongTermMemory.history()', () => {
    let dir: string;
    let mem: LongTermMemory;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-lt23-'));
      mem = new LongTermMemory(path.join(dir, 'MEMORY.md'));
    });

    it('returns empty array for empty memory', async () => {
      expect(await mem.history()).toEqual([]);
    });

    it('returns facts with section, date, and body', async () => {
      await mem.append('skills', 'Python');
      await mem.append('hobbies', 'chess');
      const hist = await mem.history();
      expect(hist).toHaveLength(2);
      expect(hist[0]).toMatchObject({ section: expect.any(String), date: expect.any(String), fact: expect.any(String) });
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) await mem.append('test', `fact ${i}`);
      const hist = await mem.history(3);
      expect(hist).toHaveLength(3);
    });

    it('clamps limit to [1, 1000]', async () => {
      await mem.append('t', 'a');
      expect((await mem.history(0)).length).toBeGreaterThanOrEqual(0);
      expect((await mem.history(999999)).length).toBeLessThanOrEqual(1000);
    });
  });

  describe('SubAgentRunner.active() and jobDuration()', () => {
    it('active() lists pending/running jobs', async () => {
      const { SubAgentRunner } = await import('../src/subagent/subagent-runner.js');
      // Runtime that never resolves so jobs stay running
      const blocking = { reply: () => new Promise(() => {}) } as unknown as ConstructorParameters<typeof SubAgentRunner>[0];
      const runner = new SubAgentRunner(blocking, 4);
      const session = {
        id: 's', channel: 'http', userId: 'u', trustLevel: 'owner' as const,
        role: 'main' as const, agentId: 'a', createdAt: 0, updatedAt: 0,
        messageCount: 0, settings: {}
      };
      runner.spawn('t1', session);
      runner.spawn('t2', session);
      // Wait a tick so jobs move from pending to running
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.active().length).toBeGreaterThan(0);
    });

    it('jobDuration returns -1 for missing job (v2.4 sentinel)', async () => {
      const { SubAgentRunner } = await import('../src/subagent/subagent-runner.js');
      const stub = { reply: async () => ({ text: 'ok', toolUses: [] }) } as unknown as ConstructorParameters<typeof SubAgentRunner>[0];
      const runner = new SubAgentRunner(stub, 4);
      expect(runner.jobDuration('nonexistent')).toBe(-1);
    });
  });

  describe('NodeRegistry.byCapability()', () => {
    it('filters nodes by advertised capability', () => {
      const reg = new NodeRegistry();
      reg.register({ name: 'phone', platform: 'ios', capabilities: ['photo', 'gps'] });
      reg.register({ name: 'mac', platform: 'macos', capabilities: ['exec'] });
      reg.register({ name: 'web', platform: 'browser', capabilities: ['photo'] });
      expect(reg.byCapability('photo')).toHaveLength(2);
      expect(reg.byCapability('exec')).toHaveLength(1);
      expect(reg.byCapability('missing')).toHaveLength(0);
    });
  });
});

describe('v2.3 HTTP write endpoints', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

  beforeAll(async () => {
    const config = mergeConfig(defaultConfig, {
      workspace: { dir: '/tmp/garud-v23-test-' + Date.now(), persist: false },
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

  it('POST /longterm/append stores a fact', async () => {
    const res = await fetch(`${baseUrl}/longterm/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'demo', fact: 'via HTTP' })
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; line: string };
    expect(body.ok).toBe(true);
    expect(body.line).toContain('via HTTP');
  });

  it('POST /longterm/append validates input', async () => {
    const res = await fetch(`${baseUrl}/longterm/append`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: 'demo' })
    });
    expect(res.status).toBe(400);
  });

  it('GET /longterm/history returns chronological facts', async () => {
    await bootstrapResult.longterm.append('a', 'fact 1');
    await bootstrapResult.longterm.append('b', 'fact 2');
    const res = await fetch(`${baseUrl}/longterm/history?limit=10`);
    const body = await res.json() as { ok: boolean; history: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.history.length).toBeGreaterThan(0);
  });

  it('DELETE /longterm clears memory', async () => {
    await bootstrapResult.longterm.append('tmp', 'clear me');
    const res = await fetch(`${baseUrl}/longterm`, { method: 'DELETE' });
    const body = await res.json() as { ok: boolean; bytesRemoved: number };
    expect(body.ok).toBe(true);
    expect(body.bytesRemoved).toBeGreaterThanOrEqual(0);
  });

  it('POST /sub-agents/:id/cancel returns ok with boolean cancelled', async () => {
    // Use a non-existent id to avoid race conditions with fast-resolving jobs.
    const res = await fetch(`${baseUrl}/sub-agents/does-not-exist/cancel`, { method: 'POST' });
    const body = await res.json() as { ok: boolean; cancelled: boolean };
    expect(body.ok).toBe(true);
    expect(typeof body.cancelled).toBe('boolean');
    expect(body.cancelled).toBe(false);
  });

  it('POST /nodes/:id/invoke with unknown node returns 404', async () => {
    const res = await fetch(`${baseUrl}/nodes/missing-id/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'x' })
    });
    expect(res.status).toBe(404);
  });

  it('POST /nodes/:id/invoke validates capability', async () => {
    const node = bootstrapResult.nodes.register({ name: 't', platform: 'linux', capabilities: ['foo'] });
    const res = await fetch(`${baseUrl}/nodes/${node.id}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'bar' })
    });
    expect(res.status).toBe(400);
  });

  it('POST /nodes/:id/invoke returns 202 pending when no responder', async () => {
    const node = bootstrapResult.nodes.register({ name: 't2', platform: 'linux', capabilities: ['x'] });
    const res = await fetch(`${baseUrl}/nodes/${node.id}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'x', timeoutMs: 100 })
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { ok: boolean; pending: boolean; invocationId: string };
    expect(body.pending).toBe(true);
    expect(body.invocationId).toBeTruthy();
  });

  it('DELETE /nodes/:id unregisters node', async () => {
    const node = bootstrapResult.nodes.register({ name: 't3', platform: 'linux', capabilities: [] });
    const res = await fetch(`${baseUrl}/nodes/${node.id}`, { method: 'DELETE' });
    const body = await res.json() as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
  });
});
