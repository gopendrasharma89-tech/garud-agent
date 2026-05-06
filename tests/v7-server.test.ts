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
    workspace: { dir: '/tmp/garud-v7-test-' + Date.now(), persist: false },
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

describe('v0.7 server endpoints', () => {
  it('/api/version returns build info', async () => {
    const res = await fetch(`${baseUrl}/api/version`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      version: string;
      releasedAt: string;
      codename: string;
      node: string;
      uptime: number;
    };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('1.0.0');
    expect(body.codename).toBe('Garuda');
    expect(body.releasedAt).toBe('2026-05-06');
    expect(body.node).toMatch(/^v\d+/);
    expect(typeof body.uptime).toBe('number');
  });

  it('SSE chunking respects word boundaries', async () => {
    const res = await fetch(`${baseUrl}/message/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'http', userId: 'sse-user', text: 'echo test' })
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      if (buf.includes('event: done')) break;
    }
    expect(buf).toContain('event: start');
    expect(buf).toContain('event: done');
  });
});
