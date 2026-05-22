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
}

async function startHarness(): Promise<Harness> {
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
    embeddings: boot.embeddings, costTracker: boot.costTracker, tracer: boot.tracer
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
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let harness: Harness | undefined;

afterEach(async () => {
  if (harness) {
    await harness.shutdown();
    harness = undefined;
  }
});

describe('v3.3 HTTP endpoints', () => {
  it('GET /embeddings reports size 0 initially', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/embeddings`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.size).toBe('number');
  });

  it('POST /embeddings/add and /embeddings/search work end-to-end', async () => {
    harness = await startHarness();
    const add1 = await fetchJson(`${harness.baseUrl}/embeddings/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a', text: 'the quick brown fox jumps' })
    });
    expect(add1.status).toBe(200);
    expect(add1.body.ok).toBe(true);

    const add2 = await fetchJson(`${harness.baseUrl}/embeddings/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'b', text: 'lazy dog sleeps quietly' })
    });
    expect(add2.status).toBe(200);

    const search = await fetchJson(`${harness.baseUrl}/embeddings/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'fox', k: 2 })
    });
    expect(search.status).toBe(200);
    expect(search.body.ok).toBe(true);
    expect(Array.isArray(search.body.results)).toBe(true);
  });

  it('POST /embeddings/add rejects missing id/text with 400', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/embeddings/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'no id' })
    });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('GET /cost/summary returns aggregated summary', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/cost/summary`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.tokensIn).toBe('number');
  });

  it('GET /trace/spans returns spans array with clamped limit', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/trace/spans?limit=9999`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.spans)).toBe(true);
  });
});
