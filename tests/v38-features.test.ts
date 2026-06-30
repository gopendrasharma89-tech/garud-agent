import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { McpServer } from '../src/mcp/mcp-server.js';
import { McpClient } from '../src/mcp/mcp-client.js';
import { openSse, pipeToSse } from '../src/streaming/sse.js';
import { buildSystemTools } from '../src/system/system-tools.js';
import { buildBrowserTools } from '../src/browser/browser-tools.js';
import type { ToolDefinition, ToolResult, ToolContext } from '../src/types.js';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-v38-')); });

function fakeCtx(): ToolContext {
  const noopLog: any = { info: () => { /* noop */ }, warn: () => { /* noop */ }, error: () => { /* noop */ }, debug: () => { /* noop */ }, child: () => noopLog };
  return {
    session: { id: 's', channel: 'test', userId: 'u', trustLevel: 'guest', role: 'channel', agentId: 'default', createdAt: 0, updatedAt: 0, messageCount: 0, settings: {} },
    requestText: '',
    now: Date.now(),
    log: noopLog,
    signal: new AbortController().signal
  };
}

describe('v3.8 Nimbostratus subsystems', () => {
  describe('System tools', () => {
    it('all tools return disabled message when GARUD_SYSTEM_ACCESS is off', async () => {
      const tools = buildSystemTools({ enabled: false });
      for (const t of tools) {
        const r = await Promise.resolve(t.execute('{}', fakeCtx()));
        expect(r.error).toBe(true);
        expect(r.content).toMatch(/disabled/);
      }
    });

    it('fs.read respects fsAllow allowlist', async () => {
      await fs.writeFile(path.join(tmp, 'ok.txt'), 'hello');
      const tools = buildSystemTools({ enabled: true, fsAllow: [tmp] });
      const fsRead = tools.find((t) => t.name === 'fs.read')!;
      const allowed = await Promise.resolve(fsRead.execute(JSON.stringify({ path: path.join(tmp, 'ok.txt') }), fakeCtx()));
      expect(allowed.content).toBe('hello');
      const denied = await Promise.resolve(fsRead.execute(JSON.stringify({ path: '/etc/passwd' }), fakeCtx()));
      expect(denied.error).toBe(true);
      expect(denied.content).toMatch(/not allowed/);
    });

    it('shell.exec respects execAllow allowlist', async () => {
      const tools = buildSystemTools({ enabled: true, execAllow: ['echo'] });
      const sh = tools.find((t) => t.name === 'shell.exec')!;
      const ok = await Promise.resolve(sh.execute(JSON.stringify({ cmd: 'echo hello' }), fakeCtx()));
      expect(ok.error).toBeUndefined();
      expect(ok.content).toContain('hello');
      const bad = await Promise.resolve(sh.execute(JSON.stringify({ cmd: 'rm -rf /' }), fakeCtx()));
      expect(bad.error).toBe(true);
      expect(bad.content).toMatch(/allowlist/);
    });

    it('env.read masks secret-like vars', () => {
      const tools = buildSystemTools({ enabled: true });
      const envR = tools.find((t) => t.name === 'env.read')!;
      const prev = process.env.GARUD_TEST_SECRET;
      process.env.GARUD_TEST_SECRET = 'super';
      try {
        const out = envR.execute('', fakeCtx()) as ToolResult;
        const obj = JSON.parse(out.content);
        expect(obj.GARUD_TEST_SECRET).toBe('***');
      } finally {
        if (prev === undefined) delete process.env.GARUD_TEST_SECRET;
        else process.env.GARUD_TEST_SECRET = prev;
      }
    });
  });

  describe('Browser tools (disabled path)', () => {
    it('returns disabled error when GARUD_BROWSER is off', async () => {
      const tools = buildBrowserTools({ enabled: false });
      for (const t of tools) {
        const r = await Promise.resolve(t.execute(JSON.stringify({ url: 'https://example.com' }), fakeCtx()));
        expect(r.error).toBe(true);
        expect(r.content).toMatch(/disabled/);
      }
    });
  });

  describe('SSE writer', () => {
    it('streams events to a real HTTP response', async () => {
      const received: string[] = [];
      const server = http.createServer((_req, res) => {
        const writer = openSse(res, { requestId: 'r1' });
        writer.event('token', { text: 'hello' });
        writer.event('token', { text: ' world' });
        writer.event('done', {});
        writer.close();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/`);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received.push(decoder.decode(value));
      }
      server.close();
      const buf = received.join('');
      expect(buf).toMatch(/event: token/);
      expect(buf).toContain('"text":"hello"');
      expect(buf).toMatch(/event: done/);
    });

    it('pipeToSse forwards chunks and emits done', async () => {
      const events: string[] = [];
      // Fake SSE writer that just captures events.
      const writer = {
        event: (name: string, _data: unknown) => events.push(name),
        data: () => { /* noop */ },
        close: () => { /* noop */ },
        alive: () => true
      };
      async function* gen() { yield 'a'; yield 'b'; yield 'c'; }
      await pipeToSse(writer, gen());
      expect(events.filter((e) => e === 'token').length).toBe(3);
      expect(events[events.length - 1]).toBe('done');
    });
  });

  describe('MCP client \u2194 server roundtrip', () => {
    it('completes initialize/listTools/callTool over a real subprocess', async () => {
      // Build a tiny MCP server script we run as a subprocess.
      const fakeTool: ToolDefinition = {
        name: 'memory.save',
        description: 'fake save',
        execute: (input: string) => ({ content: `saved:${input}` })
      };
      const serverScript = path.join(tmp, 'server.mts');
      await fs.writeFile(serverScript, `
import { McpServer } from '${path.resolve('src/mcp/mcp-server.ts').replace(/\\/g, '/')}';
const tools = {
  list: () => [${JSON.stringify({ name: fakeTool.name, description: fakeTool.description })}],
  get: (n) => n === 'memory.save' ? { name: 'memory.save', execute: (input) => ({ content: 'saved:' + input }) } : undefined,
  register: () => {},
  size: () => 1
};
const s = new McpServer({ tools, exposeAll: true });
await s.listen();
`);
      const client = new McpClient({ command: process.execPath, args: ['--import', 'tsx', serverScript], requestTimeoutMs: 5000 });
      const init = await client.start();
      expect(init.capabilities).toBeDefined();
      const tools = await client.listTools();
      expect(tools.length).toBe(1);
      expect(tools[0]!.name).toBe('memory.save');
      const callRes = await client.callTool('memory.save', { foo: 'bar' });
      expect(callRes.isError).toBeUndefined();
      const content = (callRes.content as Array<{ text: string }>)[0]!.text;
      expect(content).toContain('saved:');
      await client.stop();
    }, 15_000);

    it('client surfaces server errors cleanly', async () => {
      const serverScript = path.join(tmp, 'err-server.mts');
      await fs.writeFile(serverScript, `
import { McpServer } from '${path.resolve('src/mcp/mcp-server.ts').replace(/\\/g, '/')}';
const tools = { list: () => [], get: () => undefined, register: () => {}, size: () => 0 };
const s = new McpServer({ tools, exposeAll: true });
await s.listen();
`);
      const client = new McpClient({ command: process.execPath, args: ['--import', 'tsx', serverScript], requestTimeoutMs: 5000 });
      await client.start();
      await expect(client.callTool('does-not-exist', {})).rejects.toThrow(/unknown tool/);
      await client.stop();
    }, 15_000);
  });
});

let teardown: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of teardown) try { await f(); } catch { /* noop */ }
  teardown = [];
});
