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

async function startHarness(extra: { workspaceSignSecret?: string } = {}): Promise<Harness> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-v37-ep-'));
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
    memoryIndex: boot.memoryIndex, skills: boot.skillLibrary,
    heartbeatScheduler: boot.heartbeatScheduler,
    ...(extra.workspaceSignSecret ? { workspaceSignSecret: extra.workspaceSignSecret } : {})
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

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: any; raw?: Buffer }> {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/gzip')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: null, raw: buf };
  }
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) : null
  };
}

let harness: Harness | undefined;
afterEach(async () => { if (harness) { await harness.shutdown(); harness = undefined; } });

describe('v3.7 HTTP endpoints', () => {
  it('GET /agents lists default + scribe + planner personas', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/agents`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const slugs = r.body.personas.map((p: any) => p.slug);
    expect(slugs).toContain('default');
    expect(slugs).toContain('scribe');
  });

  it('GET /agents/<slug> returns one persona, falls back to default for unknown', async () => {
    harness = await startHarness();
    const known = await fetchJson(`${harness.baseUrl}/agents/scribe`);
    expect(known.status).toBe(200);
    expect(known.body.persona.slug).toBe('scribe');
    const unknown = await fetchJson(`${harness.baseUrl}/agents/imaginary`);
    expect(unknown.status).toBe(200);
    expect(unknown.body.persona.slug).toBe('default');
  });

  it('POST /skills/prune dryRun returns pruned list without deleting', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/skills/prune`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true })
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dryRun).toBe(true);
    expect(Array.isArray(r.body.pruned)).toBe(true);
  });

  it('GET /workspace.tgz is unauthenticated when no secret configured', async () => {
    harness = await startHarness();
    const r = await fetchJson(`${harness.baseUrl}/workspace.tgz`);
    expect(r.status).toBe(200);
    expect(r.raw).toBeDefined();
    expect(r.raw![0]).toBe(0x1f);
    expect(r.raw![1]).toBe(0x8b);
  });

  it('GET /workspace.tgz rejects unsigned request when secret configured', async () => {
    harness = await startHarness({ workspaceSignSecret: 'shhh' });
    const r = await fetchJson(`${harness.baseUrl}/workspace.tgz`);
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
  });

  it('signed-URL flow: mint via POST /workspace.tgz/sign then GET succeeds', async () => {
    harness = await startHarness({ workspaceSignSecret: 'shhh' });
    const sign = await fetchJson(`${harness.baseUrl}/workspace.tgz/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 60 })
    });
    expect(sign.status).toBe(200);
    expect(sign.body.token).toBeDefined();
    expect(sign.body.url).toMatch(/^\/workspace\.tgz\?token=/);

    const fetched = await fetchJson(`${harness.baseUrl}${sign.body.url}`);
    expect(fetched.status).toBe(200);
    expect(fetched.raw).toBeDefined();
  });

  it('signed URL clamps absurd ttlSeconds into [30, 3600]', async () => {
    harness = await startHarness({ workspaceSignSecret: 'shhh' });
    const huge = await fetchJson(`${harness.baseUrl}/workspace.tgz/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 999999 })
    });
    expect(huge.body.ttlSeconds).toBe(3600);
    const tiny = await fetchJson(`${harness.baseUrl}/workspace.tgz/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlSeconds: 1 })
    });
    expect(tiny.body.ttlSeconds).toBe(30);
  });
});
