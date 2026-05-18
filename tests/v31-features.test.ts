import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AddressInfo } from 'node:net';
import { parseSlack } from '../src/channels/adapters/slack-adapter.js';
import { parseTelegram } from '../src/channels/adapters/telegram-adapter.js';
import { parseDiscord } from '../src/channels/adapters/discord-adapter.js';
import { mascot } from '../src/mascot.js';
import { Heartbeat } from '../src/heartbeat/heartbeat.js';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

describe('v3.1 Slack adapter', () => {
  it('returns the URL-verification challenge', () => {
    const r = parseSlack({ type: 'url_verification', challenge: 'abc' });
    expect(r.challenge).toBe('abc');
    expect(r.messages).toEqual([]);
  });

  it('parses event_callback message into IncomingMessage', () => {
    const envelope = {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'EV-1',
      event: { type: 'message', user: 'U1', text: 'hi slack', channel: 'C1', ts: '1234.5' }
    };
    const r = parseSlack(envelope);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      channel: 'slack',
      userId: 'U1',
      text: 'hi slack',
      clientId: 'EV-1'
    });
  });

  it('skips bot messages and subtypes (no loops)', () => {
    const bot = { type: 'event_callback', event: { type: 'message', user: 'U', text: 'x', bot_id: 'B1' } };
    const subtype = { type: 'event_callback', event: { type: 'message', user: 'U', text: 'x', subtype: 'channel_join' } };
    expect(parseSlack(bot).messages).toEqual([]);
    expect(parseSlack(subtype).messages).toEqual([]);
  });

  it('rejects non-event payloads', () => {
    expect(parseSlack(null).messages).toEqual([]);
    expect(parseSlack({ type: 'other' }).messages).toEqual([]);
  });
});

describe('v3.1 adapter improvements', () => {
  it('Telegram parses photo as descriptive placeholder', () => {
    const update = {
      message: {
        message_id: 1,
        from: { id: 99, username: 'u' },
        chat: { id: 1 },
        photo: [{ file_id: 'p1' }]
      }
    };
    const msgs = parseTelegram(update);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toBe('[photo]');
    expect(msgs[0]?.metadata?.mediaType).toBe('photo');
  });

  it('Telegram parses voice as descriptive placeholder', () => {
    const update = {
      message: { message_id: 2, from: { id: 99 }, chat: { id: 1 }, voice: { file_id: 'v1' } }
    };
    const msgs = parseTelegram(update);
    expect(msgs[0]?.text).toBe('[voice]');
    expect(msgs[0]?.metadata?.mediaType).toBe('voice');
  });

  it('Telegram parses document with filename', () => {
    const update = {
      message: { message_id: 3, from: { id: 99 }, chat: { id: 1 }, document: { file_id: 'd1', file_name: 'spec.pdf' } }
    };
    const msgs = parseTelegram(update);
    expect(msgs[0]?.text).toContain('spec.pdf');
  });

  it('Telegram captions are picked up when text is missing', () => {
    const update = {
      message: { message_id: 4, from: { id: 99 }, chat: { id: 1 }, photo: [{ file_id: 'p' }], caption: 'a caption' }
    };
    const msgs = parseTelegram(update);
    expect(msgs[0]?.text).toBe('a caption');
  });

  it('Discord preserves option names in slash command text', () => {
    const interaction = {
      type: 2,
      id: 'i1',
      member: { user: { id: 'u', username: 'd' } },
      data: { name: 'set', options: [{ name: 'key', value: 'theme' }, { name: 'value', value: 'dark' }] }
    };
    const msgs = parseDiscord(interaction);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toBe('/set key=theme value=dark');
    expect(msgs[0]?.metadata?.commandName).toBe('set');
  });
});

describe('v3.1 mascot NO_COLOR support', () => {
  it('disables color when NO_COLOR env is set', () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const art = mascot();
      expect(art).not.toContain('\x1b[');
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it('explicit color option overrides NO_COLOR', () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const art = mascot({ color: true });
      expect(art).toContain('\x1b[');
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

describe('v3.1 Heartbeat parallel listeners', () => {
  it('does not block fast listeners on slow ones', async () => {
    const hb = new Heartbeat(60_000, () => 0);
    const order: string[] = [];
    hb.on(async () => { await new Promise((r) => setTimeout(r, 50)); order.push('slow'); });
    hb.on(() => { order.push('fast'); });
    await hb.beat();
    // Fast listener should not be queued behind slow one.
    expect(order[0]).toBe('fast');
  });

  it('isolates listener errors from other listeners', async () => {
    const hb = new Heartbeat(60_000, () => 0);
    let ranSecond = false;
    hb.on(() => { throw new Error('boom'); });
    hb.on(() => { ranSecond = true; });
    await hb.beat();
    expect(ranSecond).toBe(true);
  });
});

describe('v3.1 server endpoints', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

  beforeAll(async () => {
    const config = mergeConfig(defaultConfig, {
      workspace: { dir: '/tmp/garud-v31-test-' + Date.now(), persist: false },
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
      hooks: bootstrapResult.hooks,
      workspace: bootstrapResult.workspace,
      heartbeat: bootstrapResult.heartbeat
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await bootstrapResult.scheduler?.stop();
  });

  it('POST /channel/slack returns challenge as plain text', async () => {
    const res = await fetch(`${baseUrl}/channel/slack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'verify-me' })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toBe('verify-me');
  });

  it('POST /channel/slack ingests event_callback', async () => {
    const res = await fetch(`${baseUrl}/channel/slack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'event_callback',
        event: { type: 'message', user: 'U-1', text: 'hello slack' }
      })
    });
    const body = await res.json() as { ok: boolean; accepted: string[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.accepted)).toBe(true);
  });

  it('POST /sessions/:id/compact returns plan', async () => {
    // Generate a session via /message first
    const msg = await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'compact-user', text: 'hi for compaction' })
    });
    expect(msg.status).toBe(200);
    const sessions = await (await fetch(`${baseUrl}/sessions`)).json() as Array<{ id: string; userId: string }>;
    const sess = sessions.find((s) => s.userId === 'compact-user');
    expect(sess).toBeDefined();
    const res = await fetch(`${baseUrl}/sessions/${sess!.id}/compact`, { method: 'POST' });
    expect(res.status).toBe(200);
    const plan = await res.json() as { ok: boolean; sessionId: string; before: number; after: number };
    expect(plan.ok).toBe(true);
    expect(plan.sessionId).toBe(sess!.id);
    expect(typeof plan.before).toBe('number');
    expect(typeof plan.after).toBe('number');
  });

  it('POST /sessions/:id/compact 404 for missing session', async () => {
    const res = await fetch(`${baseUrl}/sessions/does-not-exist/compact`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
