import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodeRunner } from '../src/sandbox/code-runner.js';
import { DurableWorkflowRunner } from '../src/workflow/durable-workflow.js';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-v40-')); });

describe('v4.0 Cumulonimbus subsystems', () => {
  describe('CodeRunner (sandboxed JS)', () => {
    it('returns disabled error when GARUD_CODE_SANDBOX is off', async () => {
      const cr = new CodeRunner({ enabled: false });
      const r = await cr.run({ code: 'return 1+1' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/disabled/);
    });

    it('executes a simple expression and returns the result', async () => {
      const cr = new CodeRunner({ enabled: true });
      const r = await cr.run({ code: 'return 2 + 3' });
      expect(r.ok).toBe(true);
      expect(r.result).toBe(5);
    });

    it('exposes `input` inside the sandbox', async () => {
      const cr = new CodeRunner({ enabled: true });
      const r = await cr.run({ code: 'return input.a + input.b', input: { a: 7, b: 8 } });
      expect(r.ok).toBe(true);
      expect(r.result).toBe(15);
    });

    it('captures console.log into stdout', async () => {
      const cr = new CodeRunner({ enabled: true });
      const r = await cr.run({ code: 'console.log("hello from sandbox"); return 1' });
      expect(r.ok).toBe(true);
      expect(r.stdout).toContain('hello from sandbox');
    });

    it('reports an error when user code throws', async () => {
      const cr = new CodeRunner({ enabled: true });
      const r = await cr.run({ code: 'throw new Error("boom")' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('boom');
    });

    it('rejects when code is missing', async () => {
      const cr = new CodeRunner({ enabled: true });
      const r = await cr.run({ code: '' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/code required/);
    });

    it('isolates the sandbox: no require / fs / process leakage', async () => {
      const cr = new CodeRunner({ enabled: true });
      const r = await cr.run({ code: 'return typeof require + "|" + typeof process + "|" + typeof fs' });
      expect(r.ok).toBe(true);
      // None of those globals should be defined inside the vm context.
      expect(r.result).toBe('undefined|undefined|undefined');
    });

    it('times out long-running code', async () => {
      const cr = new CodeRunner({ enabled: true });
      const r = await cr.run({ code: 'while (true) {}', timeoutMs: 200 });
      expect(r.ok).toBe(false);
      expect(r.timedOut).toBe(true);
    }, 10000);
  });

  describe('DurableWorkflowRunner', () => {
    it('runs all steps and writes a JSONL log', async () => {
      const wf = new DurableWorkflowRunner(tmp);
      const r = await wf.run('greet', { name: 'world', greeting: '' }, [
        { name: 'capitalize', run: (s: any) => ({ name: s.name.toUpperCase() }) },
        { name: 'compose', run: (s: any) => ({ greeting: `hello ${s.name}` }) }
      ]);
      expect(r.status).toBe('completed');
      expect(r.completedSteps).toEqual(['capitalize', 'compose']);
      expect((r.state as any).greeting).toBe('hello WORLD');
      // Verify JSONL log written.
      const body = await fs.readFile(path.join(tmp, 'greet.jsonl'), 'utf8');
      expect(body).toContain('"t":"start"');
      expect(body).toContain('"t":"done"');
    });

    it('resumes from prior checkpoints: completed steps are skipped', async () => {
      const wf = new DurableWorkflowRunner(tmp);
      let firstRanTwice = 0;
      let secondRan = 0;
      const steps = [
        { name: 'first', run: () => { firstRanTwice++; return { a: 1 }; } },
        { name: 'second', run: () => { secondRan++; return { b: 2 }; } }
      ];
      await wf.run('demo', { a: 0, b: 0 }, steps);
      // Second invocation: should skip 'first' and 'second' both since done event is logged.
      const r2 = await wf.run('demo', { a: 0, b: 0 }, steps);
      expect(r2.status).toBe('resumed-completed');
      expect(firstRanTwice).toBe(1);
      expect(secondRan).toBe(1);
    });

    it('resumes mid-workflow when a prior step failed', async () => {
      const wf = new DurableWorkflowRunner(tmp);
      let counter = 0;
      const flaky = {
        name: 'flaky',
        run: () => { counter++; if (counter === 1) throw new Error('first try fails'); return { done: true }; }
      };
      const r1 = await wf.run('retry', {}, [
        { name: 'setup', run: () => ({ ready: true }) },
        flaky
      ]);
      expect(r1.status).toBe('failed');
      expect(r1.failedStep).toBe('flaky');
      // Second run: 'setup' was completed and persisted, only 'flaky' re-runs.
      const r2 = await wf.run('retry', {}, [
        { name: 'setup', run: () => { throw new Error('setup should be skipped now'); } },
        flaky
      ]);
      expect(r2.status).toBe('resumed-completed');
      expect(counter).toBe(2);
    });

    it('inspect() reports completed steps without re-running', async () => {
      const wf = new DurableWorkflowRunner(tmp);
      await wf.run('insp', {}, [
        { name: 'a', run: () => ({ x: 1 }) },
        { name: 'b', run: () => ({ y: 2 }) }
      ]);
      const i = await wf.inspect('insp');
      expect(i.completedSteps).toEqual(['a', 'b']);
      expect(i.events.find((e) => e.t === 'done')).toBeDefined();
    });

    it('list() and reset() manage workflow ids on disk', async () => {
      const wf = new DurableWorkflowRunner(tmp);
      await wf.run('one', {}, [{ name: 's', run: () => ({}) }]);
      await wf.run('two', {}, [{ name: 's', run: () => ({}) }]);
      const ids = await wf.list();
      expect(ids.sort()).toEqual(['one', 'two']);
      expect(await wf.reset('one')).toBe(true);
      expect(await wf.reset('one')).toBe(false);
      expect((await wf.list()).sort()).toEqual(['two']);
    });
  });
});
