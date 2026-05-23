import { describe, it, expect } from 'vitest';
import { verifyHmac, signHmac } from '../src/channels/hmac-verify.js';
import { AutoCostBrain } from '../src/brain/auto-cost-brain.js';
import { CostTracker } from '../src/cost/cost-tracker.js';
import { AgentGraph, END } from '../src/graph/agent-graph.js';
import { Crew } from '../src/crew/crew.js';
import type { BrainProvider } from '../src/brain/brain.js';
import type { Session } from '../src/types.js';

describe('v3.4 Stratus subsystems', () => {
  describe('HMAC verifier', () => {
    it('accepts a correctly signed body', () => {
      const sig = signHmac('s3cr3t', 'hello');
      const r = verifyHmac('s3cr3t', 'hello', sig);
      expect(r.ok).toBe(true);
    });

    it('rejects tampered body in constant time', () => {
      const sig = signHmac('s3cr3t', 'hello');
      const r = verifyHmac('s3cr3t', 'hello tampered', sig);
      expect(r.ok).toBe(false);
    });

    it('rejects missing/empty signature', () => {
      const r = verifyHmac('s3cr3t', 'hello', undefined);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('signature missing');
    });

    it('rejects unconfigured secret', () => {
      const r = verifyHmac(undefined, 'hello', 'sha256=abc');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('secret not configured');
    });

    it('rejects malformed hex signature', () => {
      const r = verifyHmac('s3cr3t', 'hello', 'sha256=ZZZ_not_hex');
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('malformed signature');
    });

    it('rejects oversize body', () => {
      const big = 'x'.repeat(1024);
      const sig = signHmac('s3cr3t', big);
      const r = verifyHmac('s3cr3t', big, sig, { maxBodyBytes: 256 });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('body too large');
    });

    it('accepts raw hex digest without algorithm prefix', () => {
      const full = signHmac('s3cr3t', 'hello');
      const hexOnly = full.split('=', 2)[1]!;
      const r = verifyHmac('s3cr3t', 'hello', hexOnly);
      expect(r.ok).toBe(true);
    });
  });

  describe('AutoCostBrain', () => {
    it('records into CostTracker on plan() and compose()', async () => {
      const tracker = new CostTracker();
      const inner: BrainProvider = {
        name: 'fake',
        plan: () => ({ tools: [] }),
        compose: () => ({ text: 'hello world from fake brain' })
      };
      const brain = new AutoCostBrain(inner, tracker);
      const session = { id: 's1' } as Session;
      await brain.plan({ input: 'go', session, availableTools: [], recentMemories: [] });
      await brain.compose({ input: 'go again', session, memories: [], toolOutputs: [] });
      const sum = tracker.summary({ sessionId: 's1' });
      expect(sum.records).toBe(2);
      expect(sum.tokensIn).toBeGreaterThan(0);
      expect(sum.tokensOut).toBeGreaterThan(0);
    });

    it('keeps the wrapped brain name transparent', () => {
      const inner: BrainProvider = { name: 'gpt-fake', plan: () => ({ tools: [] }), compose: () => ({ text: '' }) };
      const brain = new AutoCostBrain(inner, new CostTracker());
      expect(brain.name).toBe('gpt-fake');
    });
  });

  describe('AgentGraph __done short-circuit', () => {
    it('terminates early when a node writes __done=true', async () => {
      const g = new AgentGraph<{ count: number; __done?: boolean }>();
      g.addNode('a', (ctx) => ({ count: (ctx.state.count ?? 0) + 1 }));
      g.addNode('b', () => ({ __done: true }));
      g.addEdge('a', 'b');
      g.addEdge('b', END);
      g.setEntry('a');
      const r = await g.run({ count: 0 });
      expect(r.status).toBe('completed');
      expect(r.steps).toBe(2);
    });
  });

  describe('Crew add() / setMaxTurns()', () => {
    it('runs a static-reply crew end-to-end', async () => {
      const crew = new Crew();
      crew.setMaxTurns(3);
      crew.add({ name: 'researcher', role: 'finds facts', handler: () => 'fact: sky is blue' });
      crew.add({ name: 'writer', role: 'composes prose', handler: () => 'the sky is blue.' });
      const r = await crew.run('write about the sky');
      expect(r.status).toBe('completed');
      expect(r.turns.length).toBe(2);
      expect(r.turns[0]!.agent).toBe('researcher');
    });

    it('refuses duplicate member name', () => {
      const crew = new Crew();
      crew.add({ name: 'a', role: 'x', handler: () => 'y' });
      expect(() => crew.add({ name: 'a', role: 'x', handler: () => 'z' })).toThrow();
    });
  });
});
