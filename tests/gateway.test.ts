import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/agent-runtime.js';
import { DeterministicBrain } from '../src/brain/deterministic-brain.js';
import { InMemoryChannel } from '../src/channels/channel.js';
import { AuditLogger, InMemoryAuditLog } from '../src/core/audit-log.js';
import { MemoryStore } from '../src/core/memory-store.js';
import { PairingStore } from '../src/core/pairing-store.js';
import { PolicyEngine } from '../src/core/policy-engine.js';
import { RateLimiter } from '../src/core/rate-limiter.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { Gateway } from '../src/gateway.js';
import { buildBuiltinTools } from '../src/tools/builtin-tools.js';

function makeGateway(opts: { rateLimited?: boolean; pairing?: boolean } = {}) {
  const memories = new MemoryStore();
  const tools = new ToolRegistry();
  for (const t of buildBuiltinTools({ memories })) tools.register(t);
  const policy = new PolicyEngine();
  const audit = new AuditLogger();
  const sink = new InMemoryAuditLog();
  audit.addSink(sink);
  const runtime = new AgentRuntime(new DeterministicBrain(), memories, tools, policy, { audit });
  const rateLimiter = opts.rateLimited
    ? new RateLimiter({ windowMs: 1000, maxRequests: 1 })
    : undefined;
  const pairing = opts.pairing ? new PairingStore() : undefined;
  const gateway = new Gateway(runtime, {
    memories, tools, policy, audit, rateLimiter, pairing, autoPersist: false
  });
  const channel = new InMemoryChannel('http');
  gateway.registerChannel(channel);
  return { gateway, channel, sink, memories, tools };
}

describe('Gateway', () => {
  it('handles a basic message', async () => {
    const { gateway, channel } = makeGateway();
    const reply = await gateway.handle({
      channel: 'http', userId: 'owner', text: 'status please', trustLevel: 'owner'
    });
    expect(reply.text).toContain('status');
    expect(channel.delivered).toHaveLength(1);
  });

  it('rejects empty messages', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.handle({
      channel: 'http', userId: 'u1', text: '   ', trustLevel: 'owner'
    })).rejects.toThrow();
  });

  it('rejects missing channel', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.handle({
      channel: '', userId: 'u1', text: 'hi'
    })).rejects.toThrow(/channel/);
  });

  it('rejects missing userId', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.handle({
      channel: 'http', userId: '', text: 'hi'
    })).rejects.toThrow(/userId/);
  });

  it('rejects unknown channels', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.handle({
      channel: 'nowhere', userId: 'u1', text: 'hi', trustLevel: 'owner'
    })).rejects.toThrow(/Channel not registered/);
  });

  it('saves memory through the agent loop', async () => {
    const { gateway, memories } = makeGateway();
    await gateway.handle({
      channel: 'http', userId: 'owner', text: 'remember meeting at 5pm', trustLevel: 'owner'
    });
    const session = gateway.sessions.list()[0]!;
    expect(memories.list(session.id).length).toBeGreaterThan(0);
  });

  it('blocks tool calls for guests via policy', async () => {
    const { gateway, sink } = makeGateway();
    await gateway.handle({
      channel: 'http', userId: 'guest1', text: 'remember secret', trustLevel: 'guest'
    });
    const policyEntries = sink.list({ kind: 'policy' });
    expect(policyEntries.some((e) => e.detail.allow === false)).toBe(true);
  });

  it('honours rate limits and returns 429 metadata', async () => {
    const { gateway } = makeGateway({ rateLimited: true });
    const first = await gateway.handleDetailed({
      channel: 'http', userId: 'u1', text: 'first', trustLevel: 'owner'
    });
    expect(first.rateLimited).toBeFalsy();
    const second = await gateway.handleDetailed({
      channel: 'http', userId: 'u1', text: 'second', trustLevel: 'owner'
    });
    expect(second.rateLimited).toBe(true);
    expect(second.reply.notes).toContain('rate-limited');
    expect(second.rateLimit?.limit).toBe(1);
  });

  it('deduplicates by clientId', async () => {
    const { gateway } = makeGateway();
    const r1 = await gateway.handleDetailed({
      channel: 'http', userId: 'u1', text: 'hello', clientId: 'abc', trustLevel: 'owner'
    });
    const r2 = await gateway.handleDetailed({
      channel: 'http', userId: 'u1', text: 'hello', clientId: 'abc', trustLevel: 'owner'
    });
    expect(r1.duplicate).toBeFalsy();
    expect(r2.duplicate).toBe(true);
  });

  it('skips delivery when noDeliver is true', async () => {
    const { gateway, channel } = makeGateway();
    await gateway.handle({
      channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'owner'
    }, { noDeliver: true });
    expect(channel.delivered).toHaveLength(0);
  });

  it('upsertChannel replaces rather than throws', () => {
    const { gateway } = makeGateway();
    const replacement = new InMemoryChannel('http');
    gateway.upsertChannel(replacement);
    expect(gateway.channels.get('http')).toBe(replacement);
  });

  it('issuePairing emits an event and elevates on redeem', async () => {
    const { gateway } = makeGateway({ pairing: true });
    await gateway.handle({
      channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'guest'
    });
    const issued: Array<{ code: string }> = [];
    gateway.events.on('pairingIssued', (e) => issued.push(e));
    const handle = gateway.issuePairing('http', 'u1', 'trusted')!;
    expect(handle.code).toMatch(/^[0-9a-f]+$/);
    expect(issued).toHaveLength(1);
    const result = gateway.redeemPairing(handle.code);
    expect(result.ok).toBe(true);
    expect(gateway.sessions.getByUser('http', 'u1')?.trustLevel).toBe('trusted');
  });

  it('redeemPairing returns ok=false for invalid codes', () => {
    const { gateway } = makeGateway({ pairing: true });
    expect(gateway.redeemPairing('nope').ok).toBe(false);
  });

  it('reports stats', async () => {
    const { gateway } = makeGateway();
    await gateway.handle({
      channel: 'http', userId: 'u1', text: 'status', trustLevel: 'owner'
    });
    const stats = gateway.getStats();
    expect(stats.handled).toBeGreaterThan(0);
    expect(stats.sessions).toBe(1);
  });

  it('isolates sessions by agentId', async () => {
    const { gateway } = makeGateway();
    await gateway.handle({
      channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'owner', agentId: 'a'
    });
    await gateway.handle({
      channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'owner', agentId: 'b'
    });
    expect(gateway.sessions.list()).toHaveLength(2);
  });
});
