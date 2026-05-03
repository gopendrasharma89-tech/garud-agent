import { describe, expect, it } from 'vitest';
import { ToolQuotaManager } from '../src/quotas/tool-quota.js';

describe('ToolQuotaManager', () => {
  it('allows unlimited when no limit configured', () => {
    const q = new ToolQuotaManager();
    for (let i = 0; i < 100; i++) {
      expect(q.consume('s1', 'echo').allowed).toBe(true);
    }
  });

  it('respects default daily limit', () => {
    const q = new ToolQuotaManager({ defaultLimit: 3 });
    expect(q.consume('s1', 'echo').allowed).toBe(true);
    expect(q.consume('s1', 'echo').allowed).toBe(true);
    expect(q.consume('s1', 'echo').allowed).toBe(true);
    const denied = q.consume('s1', 'echo');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('honours per-tool override', () => {
    const q = new ToolQuotaManager({ defaultLimit: 100 });
    q.setToolLimit('http.fetch', 2);
    expect(q.consume('s1', 'http.fetch').allowed).toBe(true);
    expect(q.consume('s1', 'http.fetch').allowed).toBe(true);
    expect(q.consume('s1', 'http.fetch').allowed).toBe(false);
    // Other tool still allowed.
    expect(q.consume('s1', 'echo').allowed).toBe(true);
  });

  it('isolates by session', () => {
    const q = new ToolQuotaManager({ defaultLimit: 1 });
    expect(q.consume('s1', 'echo').allowed).toBe(true);
    expect(q.consume('s2', 'echo').allowed).toBe(true);
    expect(q.consume('s1', 'echo').allowed).toBe(false);
  });

  it('resets after window elapses', () => {
    let now = 0;
    const q = new ToolQuotaManager({ defaultLimit: 1, windowMs: 1000 });
    q.setTimeProvider(() => now);
    expect(q.consume('s1', 'echo').allowed).toBe(true);
    expect(q.consume('s1', 'echo').allowed).toBe(false);
    now += 1500;
    expect(q.consume('s1', 'echo').allowed).toBe(true);
  });

  it('peek does not consume', () => {
    const q = new ToolQuotaManager({ defaultLimit: 2 });
    q.peek('s1', 'echo');
    q.peek('s1', 'echo');
    q.peek('s1', 'echo');
    expect(q.consume('s1', 'echo').remaining).toBe(1);
  });

  it('reset clears specific or all buckets', () => {
    const q = new ToolQuotaManager({ defaultLimit: 1 });
    q.consume('s1', 'a');
    q.consume('s2', 'b');
    expect(q.size()).toBe(2);
    q.reset('s1');
    expect(q.size()).toBe(1);
    q.reset();
    expect(q.size()).toBe(0);
  });

  it('removing a tool limit drops back to default', () => {
    const q = new ToolQuotaManager({ defaultLimit: 5 });
    q.setToolLimit('http.fetch', 1);
    q.setToolLimit('http.fetch', undefined);
    for (let i = 0; i < 5; i++) {
      expect(q.consume('s1', 'http.fetch').allowed).toBe(true);
    }
  });
});
