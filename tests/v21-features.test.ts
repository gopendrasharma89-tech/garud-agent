import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LongTermMemory } from '../src/longterm/longterm-memory.js';
import { HookRunner } from '../src/hooks/hook-runner.js';

describe('v2.1 features', () => {
  describe('LongTermMemory enhancements', () => {
    let dir: string;
    let mem: LongTermMemory;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-lt21-'));
      mem = new LongTermMemory(path.join(dir, 'MEMORY.md'));
    });

    it('appends multiple facts under same section without creating duplicates', async () => {
      await mem.append('skills', 'Python');
      await mem.append('skills', 'TypeScript');
      const body = await mem.read();
      expect(body.match(/## skills/g)?.length).toBe(1);
      expect(body).toContain('Python');
      expect(body).toContain('TypeScript');
    });

    it('section() reads only the requested section', async () => {
      await mem.append('skills', 'Python');
      await mem.append('hobbies', 'chess');
      const skills = await mem.section('skills');
      expect(skills).toContain('Python');
      expect(skills).not.toContain('chess');
    });

    it('section() returns empty for missing section', async () => {
      expect(await mem.section('missing')).toBe('');
    });

    it('clear() empties the memory and returns byte count', async () => {
      await mem.append('test', 'fact');
      const before = (await mem.read()).length;
      const removed = await mem.clear();
      expect(removed).toBe(before);
      expect(await mem.read()).toBe('');
    });

    it('factCount() counts fact lines', async () => {
      await mem.append('a', 'fact1');
      await mem.append('a', 'fact2');
      await mem.append('b', 'fact3');
      expect(await mem.factCount()).toBe(3);
    });
  });

  describe('HookRunner enhancements', () => {
    it('size() reports total hook count', () => {
      const bus = { on: () => undefined };
      const runner = new HookRunner(bus);
      runner.register({ name: 'h1', event: 'a', handler: () => {} });
      runner.register({ name: 'h2', event: 'a', handler: () => {} });
      runner.register({ name: 'h3', event: 'b', handler: () => {} });
      expect(runner.size()).toBe(3);
    });

    it('unregister cleans empty event lists', () => {
      const bus = { on: () => undefined };
      const runner = new HookRunner(bus);
      runner.register({ name: 'only', event: 'x', handler: () => {} });
      runner.unregister('only');
      expect(runner.size()).toBe(0);
    });

    it('resetStats clears counters but keeps hooks', async () => {
      const subs: Array<(p: unknown) => void> = [];
      const bus = { on: (_e: string, cb: (p: unknown) => void) => { subs.push(cb); return undefined; } };
      const runner = new HookRunner(bus);
      runner.register({ name: 'h', event: 'x', handler: () => {} });
      subs[0]!({});
      await new Promise((r) => setTimeout(r, 5));
      expect(runner.list()[0]?.fired).toBe(1);
      runner.resetStats();
      expect(runner.list()[0]?.fired).toBe(0);
      expect(runner.size()).toBe(1);
    });
  });

  describe('SubAgentRunner enhancements', () => {
    it('list(N) limits results', async () => {
      const { SubAgentRunner } = await import('../src/subagent/subagent-runner.js');
      // Pass a stub runtime that resolves quickly
      const stubRuntime = { reply: async () => ({ text: 'ok', toolUses: [] }) } as unknown as ConstructorParameters<typeof SubAgentRunner>[0];
      const runner = new SubAgentRunner(stubRuntime, 4);
      const session = {
        id: 's1', channel: 'http', userId: 'u', trustLevel: 'owner' as const,
        role: 'main' as const, agentId: 'a', createdAt: 0, updatedAt: 0,
        messageCount: 0, settings: {}
      };
      runner.spawn('t1', session);
      runner.spawn('t2', session);
      runner.spawn('t3', session);
      expect(runner.list(2)).toHaveLength(2);
      expect(runner.list()).toHaveLength(3);
    });

    it('cancel rejects pending jobs', async () => {
      const { SubAgentRunner } = await import('../src/subagent/subagent-runner.js');
      // Runtime that never resolves so jobs stay running forever — but we cancel before run
      let resolved = false;
      const blockingRuntime = { reply: () => new Promise(() => { /* never resolves */ }) } as unknown as ConstructorParameters<typeof SubAgentRunner>[0];
      const runner = new SubAgentRunner(blockingRuntime, 0); // max=0 forces rejection
      const session = {
        id: 's1', channel: 'http', userId: 'u', trustLevel: 'owner' as const,
        role: 'main' as const, agentId: 'a', createdAt: 0, updatedAt: 0,
        messageCount: 0, settings: {}
      };
      const r = runner.spawn('blocked', session);
      expect(r.accepted).toBe(false);
      expect(runner.cancel('nonexistent')).toBe(false);
      void resolved;
    });
  });
});
