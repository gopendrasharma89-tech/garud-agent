import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { AppConfig } from '../src/types.js';

interface Harness {
  server: http.Server;
  baseUrl: string;
  shutdown: () => Promise<void>;
  config: AppConfig;
}

async function startHarness(overrides: Partial<AppConfig> = {}): Promise<Harness> {
  const config: AppConfig = {
    ...defaultConfig,
    ...overrides,
    storage: { ...defaultConfig.storage, persistent: false, ...(overrides.storage ?? {}) },
    rateLimit: { ...defaultConfig.rateLimit, enabled: false, ...(overrides.rateLimit ?? {}) },
    scheduler: { ...defaultConfig.scheduler, enabled: false, ...(overrides.scheduler ?? {}) },
    logging: { level: 'error', json: false }
  };
  const { gateway, tools } = await bootstrap(config);
  const server = createServer({ gateway, config, tools });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    shutdown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await gateway.shutdown('test-end');
    }
  };
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.shutdown();
  harness = undefined;
});

describe('HTTP server', () => {
  it('reports health publicly', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; agent: string; version: string };
    expect(body.ok).toBe(true);
    expect(body.agent).toBe('Garud');
    expect(body.version).toBe('3.5.0');
  });

  it('rejects unauthorized requests when token is set', async () => {
    harness = await startHarness({ authToken: 'secret' });
    const res = await fetch(`${harness.baseUrl}/sessions`);
    expect(res.status).toBe(401);
  });

  it('accepts authorized requests', async () => {
    harness = await startHarness({ authToken: 'secret' });
    const res = await fetch(`${harness.baseUrl}/sessions`, {
      headers: { authorization: 'Bearer secret' }
    });
    expect(res.status).toBe(200);
  });

  it('handles a message and returns a reply', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'http', userId: 'u1', text: 'status please', trustLevel: 'owner'
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; reply: { text: string } };
    expect(body.ok).toBe(true);
    expect(body.reply.text).toContain('status');
  });

  it('returns 400 for empty messages', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: '   ' })
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json'
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown routes', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('updates trust via /trust', async () => {
    harness = await startHarness();
    await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'guest' })
    });
    const res = await fetch(`${harness.baseUrl}/trust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', trust: 'trusted' })
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; session: { trustLevel: string } };
    expect(body.session.trustLevel).toBe('trusted');
  });

  it('lists tools', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.baseUrl}/tools`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; tools: Array<{ name: string }> };
    expect(body.tools.length).toBeGreaterThan(5);
    expect(body.tools.some((t) => t.name === 'memory.save')).toBe(true);
  });

  it('reports stats', async () => {
    harness = await startHarness();
    await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'owner' })
    });
    const res = await fetch(`${harness.baseUrl}/stats`);
    const body = await res.json() as { stats: { handled: number } };
    expect(body.stats.handled).toBe(1);
  });

  it('returns audit entries', async () => {
    harness = await startHarness();
    await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'owner' })
    });
    const res = await fetch(`${harness.baseUrl}/audit?limit=10`);
    const body = await res.json() as { entries: unknown[] };
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('returns 429 when rate limit hits', async () => {
    harness = await startHarness({
      rateLimit: { enabled: true, windowMs: 60_000, maxRequests: 1 }
    });
    const first = await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: 'one', trustLevel: 'owner' })
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('1');
    const second = await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: 'two', trustLevel: 'owner' })
    });
    expect(second.status).toBe(429);
  });

  it('issues and redeems pairing codes', async () => {
    harness = await startHarness();
    await fetch(`${harness.baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: 'hi', trustLevel: 'guest' })
    });
    const issued = await fetch(`${harness.baseUrl}/pairing/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', trust: 'trusted' })
    });
    const issuedBody = await issued.json() as { ok: boolean; code: string };
    expect(issuedBody.ok).toBe(true);
    const redeemed = await fetch(`${harness.baseUrl}/pairing/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: issuedBody.code })
    });
    const redeemedBody = await redeemed.json() as { ok: boolean; trustLevel: string };
    expect(redeemedBody.ok).toBe(true);
    expect(redeemedBody.trustLevel).toBe('trusted');
  });

  it('handles CORS preflight', async () => {
    harness = await startHarness({
      cors: { enabled: true, origins: ['*'] }
    });
    const res = await fetch(`${harness.baseUrl}/health`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
