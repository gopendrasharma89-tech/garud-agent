import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { bootstrap } from '../src/bootstrap.js';
import { defaultConfig } from '../src/config.js';
import { WsServer } from '../src/ws/ws-server.js';
import { AppConfig } from '../src/types.js';

interface Harness {
  server: http.Server;
  port: number;
  shutdown: () => Promise<void>;
  ws: WsServer;
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
  const { gateway } = await bootstrap(config);
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const ws = new WsServer(gateway, { path: '/ws', authToken: config.authToken });
  ws.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    port: address.port,
    ws,
    shutdown: async () => {
      ws.closeAll();
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

interface WsClient {
  socket: net.Socket;
  recv: () => Promise<unknown>;
  send: (payload: unknown) => void;
  close: () => void;
}

async function connectWs(port: number, token?: string): Promise<WsClient> {
  return new Promise<WsClient>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const messageQueue: unknown[] = [];
    const waiters: Array<(value: unknown) => void> = [];

    function tryHandshake(): void {
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buffer.slice(0, idx).toString('utf8');
      buffer = buffer.slice(idx + 4);
      if (!head.includes('101') || !head.includes(expectedAccept)) {
        reject(new Error('handshake failed: ' + head.split('\r\n')[0]));
        socket.destroy();
        return;
      }
      upgraded = true;
      drainFrames();
    }

    function drainFrames(): void {
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 0x0f;
        let len = buffer[1]! & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + len) return;
        const payload = buffer.slice(offset, offset + len).toString('utf8');
        buffer = buffer.slice(offset + len);
        if (opcode === 0x1) {
          try { const parsed = JSON.parse(payload); pushMessage(parsed); } catch { pushMessage(payload); }
        }
      }
    }

    function pushMessage(value: unknown): void {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else messageQueue.push(value);
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) tryHandshake();
      else drainFrames();
    });
    socket.on('error', (err) => reject(err));

    const headers = [
      'GET /ws HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13'
    ];
    if (token) headers.push(`Authorization: Bearer ${token}`);
    socket.write(headers.join('\r\n') + '\r\n\r\n');

    function send(payload: unknown): void {
      const data = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
      const mask = randomBytes(4);
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i]! ^ mask[i % 4]!;
      let header: Buffer;
      if (data.length < 126) {
        header = Buffer.from([0x81, 0x80 | data.length]);
      } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
      }
      socket.write(Buffer.concat([header, mask, masked]));
    }

    function recv(): Promise<unknown> {
      const buffered = messageQueue.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise<unknown>((resolveMsg, rejectMsg) => {
        const timer = setTimeout(() => rejectMsg(new Error('ws recv timeout')), 2000);
        waiters.push((value) => { clearTimeout(timer); resolveMsg(value); });
      });
    }

    function close(): void {
      try { socket.end(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    }

    setTimeout(() => {
      if (upgraded) resolve({ socket, send, recv, close });
      else reject(new Error('handshake timed out'));
    }, 500);
  });
}

describe('WebSocket server', () => {
  it('completes the handshake and sends a hello frame', async () => {
    harness = await startHarness();
    const client = await connectWs(harness.port);
    const hello = await client.recv() as { type: string; version: string };
    expect(hello.type).toBe('hello');
    expect(hello.version).toBe('4.7.0');
    client.close();
  });

  it('handles ping/pong messages', async () => {
    harness = await startHarness();
    const client = await connectWs(harness.port);
    await client.recv(); // hello
    client.send({ type: 'ping' });
    const pong = await client.recv() as { type: string };
    expect(pong.type).toBe('pong');
    client.close();
  });

  it('processes a message turn end-to-end', async () => {
    harness = await startHarness();
    const client = await connectWs(harness.port);
    await client.recv(); // hello
    client.send({
      type: 'message', channel: 'http', userId: 'ws-user',
      trustLevel: 'owner', text: 'status please'
    });
    const reply = await client.recv() as { type: string; reply: { text: string } };
    expect(reply.type).toBe('reply');
    expect(reply.reply.text).toContain('status');
    client.close();
  });

  it('rejects unknown message types', async () => {
    harness = await startHarness();
    const client = await connectWs(harness.port);
    await client.recv();
    client.send({ type: 'something-else' });
    const err = await client.recv() as { type: string; error: string };
    expect(err.type).toBe('error');
    client.close();
  });

  it('requires auth token when configured', async () => {
    harness = await startHarness({ authToken: 'secret' });
    const client = await connectWs(harness.port);
    const hello = await client.recv() as { authRequired?: boolean };
    expect(hello.authRequired).toBe(true);
    client.send({ type: 'message', channel: 'http', userId: 'u', text: 'x', trustLevel: 'owner' });
    const err = await client.recv() as { type: string };
    expect(err.type).toBe('error');
    client.close();
  });

  it('accepts auth via inline auth message', async () => {
    harness = await startHarness({ authToken: 'secret' });
    const client = await connectWs(harness.port);
    await client.recv();
    client.send({ type: 'auth', token: 'secret' });
    const ok = await client.recv() as { type: string };
    expect(ok.type).toBe('auth-ok');
    client.close();
  });

  it('reports the live client count', async () => {
    harness = await startHarness();
    const client = await connectWs(harness.port);
    await client.recv();
    expect(harness.ws.size()).toBeGreaterThan(0);
    client.close();
  });
});
