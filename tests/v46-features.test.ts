import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GARUD_VERSION, GARUD_BUILD } from '../src/version.js';
import { EventBus } from '../src/core/event-bus.js';
import { Crew, roundRobinSupervisor } from '../src/crew/crew.js';
import { SubAgentRunner } from '../src/subagent/subagent-runner.js';
import { DurableWorkflowRunner } from '../src/workflow/durable-workflow.js';
import type { AgentRuntime } from '../src/agent/agent-runtime.js';
import type { Session } from '../src/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function fakeRuntime(delayMs: number): AgentRuntime {
  return {
    reply: (_s: unknown, _i: string, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ text: 'done' }), delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      })
  } as unknown as AgentRuntime;
}

const session = { id: 'sess-v46', settings: {} } as unknown as Session;

describe('v5.0.0 "Talon" — orchestration hardening', () => {
  it('reports version 5.0.0 Talon', () => {
    expect(GARUD_VERSION).toBe('5.0.0');
    expect(GARUD_BUILD.codename).toBe('Talon');
    expect(GARUD_BUILD.releasedAt).toBe('2026-08-15');
  });
});

describe('EventBus once/waitFor + snapshot emit', () => {
  it('once() fires exactly once', () => {
    const bus = new EventBus<{ ping: number }>();
    let n = 0;
    bus.once('ping', () => { n += 1; });
    bus.emit('ping', 1);
    bus.emit('ping', 2);
    expect(n).toBe(1);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('waitFor() resolves with the next payload', async () => {
    const bus = new EventBus<{ ping: number }>();
    const p = bus.waitFor('ping');
    bus.emit('ping', 42);
    await expect(p).resolves.toBe(42);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('waitFor() rejects on timeout', async () => {
    const bus = new EventBus<{ ping: number }>();
    await expect(bus.waitFor('ping', 20)).rejects.toThrow(/timeout waiting for event/);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('handlers added during emit do not run in the same emit', () => {
    const bus = new EventBus<{ ping: number }>();
    const calls: string[] = [];
    function late(): void { calls.push('late'); }
    bus.on('ping', () => { calls.push('first'); bus.on('ping', late); });
    bus.emit('ping', 1);
    expect(calls).toEqual(['first']);
    bus.emit('ping', 2);
    expect(calls).toEqual(['first', 'first', 'late']);
  });
});

describe('Crew abort + turn timeout', () => {
  it('returns aborted immediately for a pre-aborted signal', async () => {
    const crew = new Crew().add({ name: 'a', role: 'r', handler: () => 'A' });
    const ac = new AbortController();
    ac.abort();
    const res = await crew.run('goal', { signal: ac.signal });
    expect(res.status).toBe('aborted');
    expect(res.turns.length).toBe(0);
  });

  it('aborts a run mid-turn (fixes the never-assigned aborted status)', async () => {
    const crew = new Crew().add({
      name: 'slow', role: 'r',
      handler: () => new Promise<string>((r) => setTimeout(() => r('done'), 500))
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const res = await crew.run('goal', { signal: ac.signal });
    expect(res.status).toBe('aborted');
    expect(res.turns[0]?.result).toContain('aborted');
  });

  it('bounds a stuck agent with turnTimeoutMs', async () => {
    const crew = new Crew()
      .add({ name: 'sleepy', role: 'r', handler: () => new Promise<string>((r) => setTimeout(() => r('late'), 300)) })
      .add({ name: 'quick', role: 'r', handler: () => 'fast' });
    const res = await crew.run('goal', { turnTimeoutMs: 40 });
    expect(res.status).toBe('completed');
    expect(res.turns[0]?.result).toContain('turn timeout');
    expect(res.turns[1]?.result).toBe('fast');
  });

  it('roundRobinSupervisor supports multiple cycles', async () => {
    const crew = new Crew()
      .add({ name: 'a', role: 'r', handler: () => 'A' })
      .add({ name: 'b', role: 'r', handler: () => 'B' });
    crew.setSupervisor(roundRobinSupervisor(crew, 2));
    const res = await crew.run('goal');
    expect(res.turns.map((t) => t.agent)).toEqual(['a', 'b', 'a', 'b']);
    expect(res.status).toBe('completed');
  });
});

describe('SubAgentRunner real cancellation + auto-prune', () => {
  it('cancel() aborts a running job', async () => {
    const runner = new SubAgentRunner(fakeRuntime(500));
    const { jobId, accepted } = runner.spawn('long task', session);
    expect(accepted).toBe(true);
    await sleep(20);
    expect(runner.get(jobId)?.status).toBe('running');
    expect(runner.cancel(jobId)).toBe(true);
    const job = await runner.wait(jobId, 2000);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('cancelled');
  });

  it('cancel() returns false for settled jobs', async () => {
    const runner = new SubAgentRunner(fakeRuntime(5));
    const { jobId } = runner.spawn('quick task', session);
    await runner.wait(jobId, 2000);
    expect(runner.cancel(jobId)).toBe(false);
  });

  it('auto-prunes settled jobs older than retentionMs on spawn', async () => {
    const runner = new SubAgentRunner(fakeRuntime(5), 4, undefined, 10);
    const first = runner.spawn('t1', session);
    await runner.wait(first.jobId, 2000);
    await sleep(30);
    runner.spawn('t2', session);
    expect(runner.get(first.jobId)).toBeUndefined();
  });
});

describe('DurableWorkflowRunner validation + retries', () => {
  it('rejects duplicate step names', async () => {
    const runner = new DurableWorkflowRunner(mkdtempSync(join(tmpdir(), 'garud-wf-')));
    const res = await runner.run('dup', {}, [
      { name: 'a', run: () => undefined },
      { name: 'a', run: () => undefined }
    ]);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('duplicate step name: a');
  });

  it('retries a flaky step before failing the workflow', async () => {
    const runner = new DurableWorkflowRunner(mkdtempSync(join(tmpdir(), 'garud-wf-')));
    let attempts = 0;
    const res = await runner.run('flaky', { done: false }, [{
      name: 'flaky-step',
      retries: 2,
      run: () => {
        attempts += 1;
        if (attempts < 3) throw new Error('boom');
        return { done: true };
      }
    }]);
    expect(res.status).toBe('completed');
    expect(attempts).toBe(3);
    expect(res.state.done).toBe(true);
  });
});
