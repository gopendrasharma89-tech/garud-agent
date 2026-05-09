import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LongTermMemory } from '../src/longterm/longterm-memory.js';
import { DailyLog } from '../src/longterm/daily-log.js';
import { NodeRegistry } from '../src/nodes/node-registry.js';
import { ContextCompactor } from '../src/compaction/context-compactor.js';
import { HookRunner } from '../src/hooks/hook-runner.js';

describe('v2.0 OpenClaw-inspired modules', () => {
  describe('LongTermMemory (MEMORY.md)', () => {
    let dir: string;
    let mem: LongTermMemory;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-lt-'));
      mem = new LongTermMemory(path.join(dir, 'MEMORY.md'));
    });

    it('starts empty', async () => {
      expect(await mem.read()).toBe('');
    });

    it('appends a fact under a section', async () => {
      const block = await mem.append('preferences', 'user prefers dark mode');
      expect(block).toContain('preferences');
      expect(block).toContain('user prefers dark mode');
      const body = await mem.read();
      expect(body).toContain('## preferences');
      expect(body).toContain('user prefers dark mode');
    });

    it('searches facts by substring', async () => {
      await mem.append('skills', 'knows Python');
      await mem.append('skills', 'speaks Hindi');
      await mem.append('hobbies', 'plays chess');
      const hits = await mem.search('hindi');
      expect(hits).toHaveLength(1);
      expect(hits[0]?.section).toBe('skills');
    });

    it('persists across instances', async () => {
      await mem.append('test', 'persistent fact');
      const fresh = new LongTermMemory(path.join(dir, 'MEMORY.md'));
      const body = await fresh.read();
      expect(body).toContain('persistent fact');
    });
  });

  describe('DailyLog', () => {
    let dir: string;
    let log: DailyLog;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-dl-'));
      log = new DailyLog(dir);
    });

    it('appends entries to today\'s file', async () => {
      await log.append('user', 'hello');
      await log.append('assistant', 'hi there');
      const today = new Date().toISOString().slice(0, 10);
      const body = await log.read(today);
      expect(body).toContain('[user] hello');
      expect(body).toContain('[assistant] hi there');
    });

    it('lists available dates newest first', async () => {
      await log.append('user', 'test');
      const dates = await log.listDates();
      expect(dates).toHaveLength(1);
      expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns empty body for missing date', async () => {
      expect(await log.read('1999-01-01')).toBe('');
    });
  });

  describe('NodeRegistry', () => {
    it('registers and lists nodes', () => {
      const reg = new NodeRegistry();
      const node = reg.register({ name: 'phone', platform: 'ios', capabilities: ['photo', 'gps'] });
      expect(node.id).toBeTruthy();
      expect(reg.list()).toHaveLength(1);
      expect(reg.get(node.id)?.capabilities).toContain('photo');
    });

    it('issues and resolves invocations', async () => {
      const reg = new NodeRegistry();
      const node = reg.register({ name: 'mac', platform: 'macos', capabilities: ['exec'] });
      const inv = reg.invoke(node.id, 'exec', { cmd: 'whoami' });
      expect(inv.status).toBe('pending');
      const wait = reg.wait(inv.id, 1000);
      reg.resolve(inv.id, { stdout: 'user' });
      const result = await wait;
      expect(result.status).toBe('done');
      expect((result.result as { stdout: string }).stdout).toBe('user');
    });

    it('rejects invocation on error', async () => {
      const reg = new NodeRegistry();
      const node = reg.register({ name: 'x', platform: 'linux', capabilities: ['cmd'] });
      const inv = reg.invoke(node.id, 'cmd', {});
      const wait = reg.wait(inv.id, 1000);
      reg.reject(inv.id, 'permission denied');
      const result = await wait;
      expect(result.status).toBe('failed');
      expect(result.error).toBe('permission denied');
    });

    it('times out unresolved invocations', async () => {
      const reg = new NodeRegistry();
      const node = reg.register({ name: 'slow', platform: 'headless', capabilities: ['x'] });
      const inv = reg.invoke(node.id, 'x', {});
      await expect(reg.wait(inv.id, 50)).rejects.toThrow(/timeout/);
    });

    it('unregisters nodes', () => {
      const reg = new NodeRegistry();
      const node = reg.register({ name: 'tmp', platform: 'browser', capabilities: [] });
      expect(reg.unregister(node.id)).toBe(true);
      expect(reg.list()).toHaveLength(0);
    });
  });

  describe('ContextCompactor', () => {
    it('does not compact small contexts', () => {
      const c = new ContextCompactor({ budgetChars: 1000, keepRecent: 3, pruneBelow: 0.2 });
      const turns = [
        { role: 'user' as const, content: 'hi' },
        { role: 'assistant' as const, content: 'hello' }
      ];
      const plan = c.plan(turns);
      expect(plan.removed).toBe(0);
      expect(plan.kept).toEqual(turns);
    });

    it('compacts when budget exceeded', () => {
      const c = new ContextCompactor({ budgetChars: 100, keepRecent: 2, pruneBelow: 0.2 });
      const turns = [
        { role: 'user' as const, content: 'a'.repeat(80) },
        { role: 'assistant' as const, content: 'b'.repeat(80) },
        { role: 'user' as const, content: 'recent question' },
        { role: 'assistant' as const, content: 'recent answer' }
      ];
      const plan = c.plan(turns);
      expect(plan.kept.length).toBeLessThanOrEqual(3);
      expect(plan.removed).toBeGreaterThan(0);
    });

    it('reports needsCompaction correctly', () => {
      const c = new ContextCompactor({ budgetChars: 50, keepRecent: 1, pruneBelow: 0.2 });
      const small = [{ role: 'user' as const, content: 'hi' }];
      const big = [{ role: 'user' as const, content: 'x'.repeat(100) }];
      expect(c.needsCompaction(small)).toBe(false);
      expect(c.needsCompaction(big)).toBe(true);
    });
  });

  describe('HookRunner', () => {
    it('registers and fires hooks', async () => {
      const subs: Array<(p: unknown) => void> = [];
      const bus = { on: (_e: string, cb: (p: unknown) => void) => { subs.push(cb); return undefined; } };
      const runner = new HookRunner(bus);
      let received: unknown;
      runner.register({
        name: 'log-hello',
        event: 'hello',
        handler: (p) => { received = p; }
      });
      subs[0]!({ msg: 'world' });
      await new Promise((r) => setTimeout(r, 10));
      expect((received as { msg: string }).msg).toBe('world');
      expect(runner.list()[0]?.fired).toBe(1);
    });

    it('isolates hook errors', async () => {
      const subs: Array<(p: unknown) => void> = [];
      const bus = { on: (_e: string, cb: (p: unknown) => void) => { subs.push(cb); return undefined; } };
      const runner = new HookRunner(bus);
      runner.register({
        name: 'broken',
        event: 'x',
        handler: () => { throw new Error('oops'); }
      });
      runner.register({
        name: 'next',
        event: 'x',
        handler: () => { /* no-op */ }
      });
      // Both register on the same event — only first triggers subscribe.
      subs[0]!({});
      await new Promise((r) => setTimeout(r, 10));
      const stats = runner.list();
      expect(stats.find((s) => s.name === 'broken')?.errors).toBe(1);
      expect(stats.find((s) => s.name === 'next')?.errors).toBe(0);
    });

    it('respects match filter', async () => {
      const subs: Array<(p: unknown) => void> = [];
      const bus = { on: (_e: string, cb: (p: unknown) => void) => { subs.push(cb); return undefined; } };
      const runner = new HookRunner(bus);
      let count = 0;
      runner.register({
        name: 'filtered',
        event: 'x',
        match: (p) => (p as { ok: boolean }).ok === true,
        handler: () => { count += 1; }
      });
      subs[0]!({ ok: false });
      subs[0]!({ ok: true });
      subs[0]!({ ok: false });
      await new Promise((r) => setTimeout(r, 10));
      expect(count).toBe(1);
    });

    it('unregisters hooks', () => {
      const bus = { on: () => undefined };
      const runner = new HookRunner(bus);
      runner.register({ name: 'h1', event: 'x', handler: () => {} });
      expect(runner.unregister('h1')).toBe(true);
      expect(runner.unregister('missing')).toBe(false);
    });
  });
});
