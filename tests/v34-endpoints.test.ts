import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { signHmac } from '../src/channels/hmac-verify.js';
import { AppConfig } from '../src/types.js';

interface Harness {
  server: http.Server;
  baseUrl: string;
  shutdown: () => Promise<void>;
}

async function startHarness(channelSecrets?: { whatsapp?: string; telegram?: string; discord?: string; slack?: string }): Promise<Harness> {
  const config: AppConfig = {
    ...defaultConfig,
    storage: { ...defaultConfig.storage, persistent: false },
    rateLimit: { ...defaultConfig.rateLimit, enabled: false },
    scheduler: { ...defaultConfig.scheduler, enabled: false },
    logging: { level: 'error', json: false }
  };
  const boot = await bootstrap(config);
  const server = createServer({
    gateway: boot.gateway, config, tools: boot.tools,
    embeddings: boot.embeddings, costTracker: boot.costTracker, tracer: boot.tracer,
    ...(channelSecrets ? { channelSecrets } : {})
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    shutdown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await boot.gateway.shutdown('test-end');
    }
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) : null };
}

let harness: Harness | undefined;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = undefined; } });

describe('v3.4 HTTP endpoints', () => {
  it('POST /graph/run executes a simple two-node graph', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/graph/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entry: 'a',
        initialState: { count: 0 },
        nodes: [
          { id: 'a', patch: { count: 1 } },
          { id: 'b', patch: { greeted: true }, setDone: true }
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'END' }
        ]
      })
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.result.status).toBe('completed');
    expect(r.body.result.state.count).toBe(1);
    expect(r.body.result.state.greeted).toBe(true);
  });

  it('POST /graph/run rejects missing fields with 400', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/graph/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'a' })
    });
    expect(r.status).toBe(400);
  });

  it('POST /crew/run executes a two-member crew', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/crew/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'plan a launch',
        members: [
          { name: 'pm', role: 'product manager', reply: 'milestone-1 set' },
          { name: 'eng', role: 'engineer', reply: 'service deployed' }
        ]
      })
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.result.turns.length).toBe(2);
    expect(r.body.result.turns[0].agent).toBe('pm');
  });

  it('GET /trace/size returns active+recent counts', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/trace/size`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.active).toBe('number');
    expect(typeof r.body.recent).toBe('number');
  });

  it('POST /channel/slack accepts unsigned payload when no secret', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/channel/slack`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' })
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('abc123');
  });

  it('POST /channel/slack rejects unsigned payload when secret configured', async () => {
    harness = await startHarness({ slack: 'top-secret' });
    const r = await fetchJson(`${harness.baseUrl}/channel/slack`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc123' })
    });
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
  });

  it('POST /channel/slack accepts correctly signed payload', async () => {
    harness = await startHarness({ slack: 'top-secret' });
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const sig = signHmac('top-secret', body);
    const r = await fetchJson(`${harness.baseUrl}/channel/slack`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      body
    });
    expect(r.status).toBe(200);
    expect(r.body).toBe('abc123');
  });

  it('POST /channel/slack rejects tampered body', async () => {
    harness = await startHarness({ slack: 'top-secret' });
    const realBody = JSON.stringify({ type: 'url_verification', challenge: 'good' });
    const sig = signHmac('top-secret', realBody);
    const tamperedBody = JSON.stringify({ type: 'url_verification', challenge: 'evil' });
    const r = await fetchJson(`${harness.baseUrl}/channel/slack`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      body: tamperedBody
    });
    expect(r.status).toBe(401);
  });
});
