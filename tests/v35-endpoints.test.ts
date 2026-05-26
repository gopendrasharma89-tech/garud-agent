import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  // Each test gets its own workspace so writes don't bleed across cases.
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-v35-ep-'));
  const config: AppConfig = {
    ...defaultConfig,
    storage: { ...defaultConfig.storage, persistent: false, workspaceDir },
    rateLimit: { ...defaultConfig.rateLimit, enabled: false },
    scheduler: { ...defaultConfig.scheduler, enabled: false },
    logging: { level: 'error', json: false }
  };
  const boot = await bootstrap(config);
  const server = createServer({
    gateway: boot.gateway, config, tools: boot.tools,
    workspace: boot.workspace,
    embeddings: boot.embeddings, costTracker: boot.costTracker, tracer: boot.tracer,
    memoryIndex: boot.memoryIndex, skills: boot.skillLibrary
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

describe('v3.5 HTTP endpoints', () => {
  it('GET /identity returns IDENTITY.md default body', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/identity`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.body).toContain('Identity');
  });

  it('POST /identity round-trips a custom body', async () => {
    harness = await startHarness();
    const post = await fetchJson(`${harness.baseUrl}/identity`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '# Custom\nname: TestBot' })
    });
    expect(post.status).toBe(200);
    const get = await fetchJson(`${harness.baseUrl}/identity`);
    expect(get.body.body).toContain('TestBot');
  });

  it('POST /tools.md/regenerate writes catalog with all registered tools', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/tools.md/regenerate`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.tools).toBeGreaterThan(100);
    const md = await fetchJson(`${harness.baseUrl}/tools.md`);
    expect(md.body).toContain('memory.save');
  });

  it('GET /heartbeat/rules parses default HEARTBEAT.md', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/heartbeat/rules`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rules)).toBe(true);
    expect(r.body.rules.length).toBeGreaterThan(0);
  });

  it('MEMORY.md topics round-trip via POST then GET', async () => {
    harness = await startHarness();
    const post = await fetchJson(`${harness.baseUrl}/memory/topic/bash-and-system`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '# bash\nuse set -e' })
    });
    expect(post.status).toBe(200);
    expect(post.body.topic).toBe('bash-and-system');

    const list = await fetchJson(`${harness.baseUrl}/memory/topics`);
    expect(list.body.topics).toContain('bash-and-system');

    const get = await fetchJson(`${harness.baseUrl}/memory/topic/bash-and-system`);
    expect(get.status).toBe(200);
    expect(get.body).toContain('set -e');
  });

  it('GET /memory/topic/<unknown> returns 404', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/memory/topic/does-not-exist`);
    expect(r.status).toBe(404);
  });

  it('skills extract → list → search end-to-end', async () => {
    harness = await startHarness();
    const ext = await fetchJson(`${harness.baseUrl}/skills/extract`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'verify stripe webhook signature', output: 'check hmac sha256 and route', name: 'stripe-verify', success: true })
    });
    expect(ext.status).toBe(200);
    expect(ext.body.skill.slug).toBe('stripe-verify');

    const list = await fetchJson(`${harness.baseUrl}/skills`);
    expect(list.body.slugs).toContain('stripe-verify');

    const search = await fetchJson(`${harness.baseUrl}/skills/search?q=stripe%20webhook&k=3`);
    expect(search.status).toBe(200);
    expect(search.body.results.length).toBeGreaterThan(0);
    expect(search.body.results[0].skill.slug).toBe('stripe-verify');
  });

  it('GET /doctor returns a structured report', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/doctor`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.checks)).toBe(true);
    expect(r.body.summary).toBeDefined();
    expect(typeof r.body.summary.ok).toBe('number');
  });
});
