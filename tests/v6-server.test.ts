import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AddressInfo } from 'node:net';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;

beforeAll(async () => {
  const config = mergeConfig(defaultConfig, {
    workspace: { dir: '/tmp/garud-v6-test-' + Date.now(), persist: false },
    authToken: undefined,
    dashboard: { enabled: true },
    metrics: { enabled: true }
  });
  bootstrapResult = await bootstrap(config);
  server = createServer({
    gateway: bootstrapResult.gateway,
    config,
    tools: bootstrapResult.tools,
    metrics: bootstrapResult.metrics
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await bootstrapResult.scheduler?.stop();
});

describe('v0.6 server endpoints', () => {
  it('/health reports version 0.6.0', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json() as { version: string };
    expect(body.version).toBe('0.8.0');
  });

  it('/live returns ok', async () => {
    const res = await fetch(`${baseUrl}/live`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.8.0');
  });

  it('/ready includes brain check + version', async () => {
    const res = await fetch(`${baseUrl}/ready`);
    const body = await res.json() as { ok: boolean; reasons: string[]; version: string };
    expect(body.ok).toBe(true);
    expect(body.reasons).toEqual([]);
    expect(body.version).toBe('0.8.0');
  });

  it('/slo returns error budget info', async () => {
    const res = await fetch(`${baseUrl}/slo`);
    const body = await res.json() as { ok: boolean; slo: { target: number; withinBudget: boolean } };
    expect(body.ok).toBe(true);
    expect(body.slo.target).toBe(0.01);
    expect(body.slo.withinBudget).toBe(true);
  });

  it('/audit/export returns NDJSON', async () => {
    await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u1', text: 'remember v6 launch' })
    });
    const res = await fetch(`${baseUrl}/audit/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('ndjson');
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    // Each line should be parseable JSON
    for (const line of text.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('/sessions/:id/forget wipes memories', async () => {
    const res1 = await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'u-forget', text: 'remember secret password' })
    });
    const sentBody = await res1.json() as { ok: boolean };
    expect(sentBody.ok).toBe(true);

    const sessions = await (await fetch(`${baseUrl}/sessions`)).json() as Array<{ id: string; userId: string }>;
    const sess = sessions.find((s) => s.userId === 'u-forget');
    expect(sess).toBeDefined();

    const forgetRes = await fetch(`${baseUrl}/sessions/${sess!.id}/forget`, { method: 'POST' });
    const forgetBody = await forgetRes.json() as { ok: boolean; removed: number };
    expect(forgetBody.ok).toBe(true);
    expect(forgetBody.removed).toBeGreaterThanOrEqual(0);
  });
});
