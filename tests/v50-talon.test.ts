import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GARUD_BUILD, GARUD_VERSION } from '../src/version.js';
import { AgentRouter } from '../src/gateway/agent-router.js';
import { DmPolicyEngine } from '../src/gateway/dm-policy.js';
import { SessionQueue, QueueSupersededError, QueueBusyError } from '../src/gateway/session-queue.js';
import { TelegramPoller, chunkText, TelegramTransport } from '../src/channels/pollers/telegram-poller.js';
import type { TelegramUpdate } from '../src/channels/adapters/telegram-adapter.js';
import { runOnboarding } from '../src/onboard/onboarding.js';
import { renderWebChat } from '../src/webchat/webchat-page.js';
import { defaultConfig, mergeConfig, validateConfig } from '../src/config.js';
import { bootstrap } from '../src/bootstrap.js';
import type { AppConfig, IncomingMessage, Session } from '../src/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return mergeConfig(mergeConfig(defaultConfig, {
    storage: { workspaceDir: mkdtempSync(path.join(tmpdir(), 'garud-v50-')), persistent: false },
    scheduler: { enabled: false, heartbeatMs: 60_000, sessionTtlMs: 0 },
    rateLimit: { enabled: false, windowMs: 60_000, maxRequests: 30 }
  }), overrides);
}

describe('v5.0.0 "Talon" — OpenClaw parity', () => {
  it('reports version 5.0.0 Talon', () => {
    expect(GARUD_VERSION).toBe('5.0.0');
    expect(GARUD_BUILD.codename).toBe('Talon');
  });

  it('config: new sections have safe defaults and validate', () => {
    expect(defaultConfig.commands.enabled).toBe(true);
    expect(defaultConfig.dmPolicy.defaultPolicy).toBe('open');
    expect(defaultConfig.queue.mode).toBe('queue');
    expect(defaultConfig.routing.bindings).toEqual([]);
    expect(validateConfig(defaultConfig)).toEqual([]);
    const bad = mergeConfig(defaultConfig, {
      dmPolicy: { defaultPolicy: 'wild' as never },
      queue: { mode: 'chaos' as never, maxDepth: 0 }
    });
    const issues = validateConfig(bad);
    expect(issues.some((i) => i.path === 'dmPolicy.defaultPolicy')).toBe(true);
    expect(issues.some((i) => i.path === 'queue.mode')).toBe(true);
    expect(issues.some((i) => i.path === 'queue.maxDepth')).toBe(true);
  });

  it('agent router: most specific binding wins, default as fallback', () => {
    const router = new AgentRouter([
      { agentId: 'work', channel: 'telegram' },
      { agentId: 'boss', channel: 'telegram', userId: 'u42' },
      { agentId: 'fam', userPrefix: 'fam-' }
    ], 'main');
    expect(router.resolve({ channel: 'telegram', userId: 'u42' })).toBe('boss');
    expect(router.resolve({ channel: 'telegram', userId: 'u7' })).toBe('work');
    expect(router.resolve({ channel: 'http', userId: 'fam-mom' })).toBe('fam');
    expect(router.resolve({ channel: 'http', userId: 'stranger' })).toBe('main');
  });

  it('dm policy: open/disabled/allowlist/pairing verdicts', () => {
    const engine = new DmPolicyEngine({
      defaultPolicy: 'pairing',
      channels: { http: 'open', discord: 'disabled', slack: 'allowlist' },
      allowlist: { slack: ['alice'] }
    });
    const guest = (channel: string, userId: string): Session => ({
      id: 's1', channel, userId, trustLevel: 'guest', role: 'channel', agentId: 'main',
      createdAt: 0, updatedAt: 0, messageCount: 1, settings: {}
    });
    expect(engine.evaluate(guest('http', 'x'), { channel: 'http', userId: 'x' }).action).toBe('allow');
    expect(engine.evaluate(guest('discord', 'x'), { channel: 'discord', userId: 'x' }).action).toBe('block');
    expect(engine.evaluate(guest('slack', 'alice'), { channel: 'slack', userId: 'alice' }).action).toBe('allow');
    expect(engine.evaluate(guest('slack', 'bob'), { channel: 'slack', userId: 'bob' }).action).toBe('block');
    expect(engine.evaluate(guest('telegram', 'x'), { channel: 'telegram', userId: 'x' }).action).toBe('pair');
    const trusted = { ...guest('telegram', 'x'), trustLevel: 'trusted' as const };
    expect(engine.evaluate(trusted, { channel: 'telegram', userId: 'x' }).action).toBe('allow');
    const blocked = { ...guest('http', 'x'), trustLevel: 'blocked' as const };
    expect(engine.evaluate(blocked, { channel: 'http', userId: 'x' }).action).toBe('block');
  });

  it('session queue: queue mode serializes work per key', async () => {
    const queue = new SessionQueue({ mode: 'queue' });
    const order: number[] = [];
    const job = (n: number, ms: number) => queue.run('s', async () => {
      await sleep(ms);
      order.push(n);
      return n;
    });
    const results = await Promise.all([job(1, 30), job(2, 5), job(3, 1)]);
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('session queue: steer supersedes pending messages', async () => {
    const queue = new SessionQueue({ mode: 'steer' });
    const first = queue.run('s', async () => { await sleep(30); return 'first'; });
    const second = queue.run('s', async () => 'second');
    const third = queue.run('s', async () => 'third');
    await expect(second).rejects.toBeInstanceOf(QueueSupersededError);
    expect(await first).toBe('first');
    expect(await third).toBe('third');
  });

  it('session queue: reject mode refuses concurrent work', async () => {
    const queue = new SessionQueue({ mode: 'reject' });
    const first = queue.run('s', async () => { await sleep(20); return 1; });
    await expect(queue.run('s', async () => 2)).rejects.toBeInstanceOf(QueueBusyError);
    expect(await first).toBe(1);
  });

  it('gateway: pairing policy holds strangers, approval unlocks them', async () => {
    const { gateway } = await bootstrap(testConfig({
      dmPolicy: { defaultPolicy: 'pairing' }
    }));
    const held = await gateway.handle({ channel: 'http', userId: 'stranger', text: 'hello?' });
    expect(held.notes).toContain('dm-policy:pairing');
    const code = /access: ([0-9a-f]+)/.exec(held.text)?.[1];
    expect(code).toBeTruthy();
    const approved = gateway.redeemPairing(code!);
    expect(approved.ok).toBe(true);
    const after = await gateway.handle({ channel: 'http', userId: 'stranger', text: 'hello again' });
    expect(after.notes).not.toContain('dm-policy:pairing');
    await gateway.shutdown('test');
  });

  it('gateway: /pair works in-channel even before approval', async () => {
    const { gateway } = await bootstrap(testConfig({
      dmPolicy: { defaultPolicy: 'pairing' }
    }));
    const issued = gateway.issuePairing('http', 'newbie', 'trusted');
    expect(issued).toBeTruthy();
    const reply = await gateway.handle({ channel: 'http', userId: 'newbie', text: `/pair ${issued!.code}` });
    expect(reply.text).toContain('paired!');
    const after = await gateway.handle({ channel: 'http', userId: 'newbie', text: 'now we talk' });
    expect(after.notes).not.toContain('dm-policy:pairing');
    await gateway.shutdown('test');
  });

  it('gateway: blocks disabled channels with a clear reason', async () => {
    const { gateway } = await bootstrap(testConfig({
      dmPolicy: { defaultPolicy: 'open', channels: { http: 'disabled' } }
    }));
    const reply = await gateway.handle({ channel: 'http', userId: 'x', text: 'anyone?' });
    expect(reply.notes).toContain('dm-policy:blocked');
    expect(reply.text).toContain('access denied');
    await gateway.shutdown('test');
  });

  it('gateway: slash commands answer without invoking the brain', async () => {
    const { gateway } = await bootstrap(testConfig());
    const help = await gateway.handle({ channel: 'http', userId: 'u', text: '/help' });
    expect(help.notes).toContain('command:help');
    expect(help.text).toContain('/status');
    const who = await gateway.handle({ channel: 'http', userId: 'u', text: '/whoami' });
    expect(who.text).toContain('you are u on http');
    const version = await gateway.handle({ channel: 'http', userId: 'u', text: '/version' });
    expect(version.text).toContain(GARUD_VERSION);
    const unknown = await gateway.handle({ channel: 'http', userId: 'u', text: '/wat' });
    expect(unknown.notes).toContain('command:unknown');
    expect(unknown.text).toContain('unknown command');
    await gateway.shutdown('test');
  });

  it('gateway: /new clears conversation history', async () => {
    const boot = await bootstrap(testConfig());
    const { gateway, conversation } = boot;
    await gateway.handle({ channel: 'http', userId: 'u2', text: 'remember the mango order' });
    const session = gateway.sessions.getByUser('http', 'u2')!;
    expect((conversation?.list(session.id) ?? []).length).toBeGreaterThan(0);
    const reply = await gateway.handle({ channel: 'http', userId: 'u2', text: '/new' });
    expect(reply.notes).toContain('command:new');
    expect(conversation?.list(session.id) ?? []).toHaveLength(0);
    await gateway.shutdown('test');
  });

  it('gateway: routing bindings pick the agent per message', async () => {
    const { gateway } = await bootstrap(testConfig({
      routing: { bindings: [{ agentId: 'support', channel: 'http', userId: 'vip' }] }
    }));
    await gateway.handle({ channel: 'http', userId: 'vip', text: 'hi' });
    await gateway.handle({ channel: 'http', userId: 'pleb', text: 'hi' });
    expect(gateway.sessions.getByUser('http', 'vip', 'support')).toBeTruthy();
    expect(gateway.sessions.getByUser('http', 'pleb', 'main')).toBeTruthy();
    await gateway.shutdown('test');
  });

  it('telegram poller: ticks updates through the gateway and replies via transport', async () => {
    const sent: Array<{ chatId: string | number; text: string }> = [];
    const updates: TelegramUpdate[] = [
      { update_id: 10, message: { message_id: 1, from: { id: 42 }, chat: { id: 777 }, text: 'namaste' } }
    ];
    const transport: TelegramTransport = {
      getUpdates: async () => updates.splice(0),
      sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; }
    };
    const seen: IncomingMessage[] = [];
    const poller = new TelegramPoller({
      transport,
      handle: async (m) => {
        seen.push(m);
        await poller.deliver(
          { id: 's', channel: 'telegram', userId: m.userId, trustLevel: 'owner', role: 'channel', agentId: 'main', createdAt: 0, updatedAt: 0, messageCount: 1, settings: {} },
          { text: 'pranam!', notes: [], usedTools: [], usedMemories: [] }
        );
      }
    });
    const handled = await poller.tick();
    expect(handled).toBe(1);
    expect(seen[0]!.channel).toBe('telegram');
    expect(seen[0]!.userId).toBe('42');
    expect(poller.getStats().offset).toBe(11);
    expect(sent).toEqual([{ chatId: 777, text: 'pranam!' }]);
    const second = await poller.tick();
    expect(second).toBe(0);
  });

  it('telegram poller: chunks long replies at 4096 chars', async () => {
    expect(chunkText('a'.repeat(5000)).map((c) => c.length)).toEqual([4096, 904]);
    expect(chunkText('short')).toEqual(['short']);
  });

  it('onboarding: seeds a complete workspace with safe defaults', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'garud-onboard-'));
    const result = await runOnboarding({ dir, name: 'Baaz' });
    expect(result.created).toEqual(expect.arrayContaining([
      'garud.json', 'SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md', 'HEARTBEAT.md', 'MEMORY.md'
    ]));
    const raw = await readFile(result.configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    expect(parsed.dmPolicy?.defaultPolicy).toBe('pairing');
    const merged = mergeConfig(defaultConfig, parsed);
    expect(validateConfig(merged)).toEqual([]);
    const identity = await readFile(path.join(dir, 'IDENTITY.md'), 'utf8');
    expect(identity).toContain(GARUD_VERSION);
    const again = await runOnboarding({ dir, name: 'Baaz' });
    expect(again.created).toHaveLength(0);
    expect(again.skipped.length).toBeGreaterThanOrEqual(7);
  });

  it('webchat: renders a self-contained page wired to the webhook channel', () => {
    const html = renderWebChat({ agent: 'Garud', version: GARUD_VERSION, webhookPrefix: '/webhook' });
    expect(html).toContain('garud-webchat');
    expect(html).toContain('/webhook/http');
    expect(html).toContain('Garud WebChat');
    expect(html).toContain('/new');
  });
});
