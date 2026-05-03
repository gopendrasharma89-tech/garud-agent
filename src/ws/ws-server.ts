import { createHash } from 'node:crypto';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { Gateway } from '../gateway.js';
import { IncomingMessage, Logger, TrustLevel } from '../types.js';
import { noopLogger } from '../utils/logger.js';
import { GARUD_VERSION } from '../version.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const DEFAULT_MAX_BUFFER = 1_048_576; // 1 MiB

export interface WsServerOptions {
  path: string;
  authToken?: string;
  logger?: Logger;
  /** Max bytes a single client's read buffer may hold; over this, drop them. */
  maxBufferBytes?: number;
}

export interface WsClient {
  id: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface InternalClient extends WsClient {
  socket: Duplex;
  buffer: Buffer;
  authorized: boolean;
}

/**
 * Minimal RFC 6455 WebSocket server (text frames only). Includes a hard cap on
 * per-client buffer size to prevent memory blow-up from misbehaving clients.
 */
export class WsServer {
  private clients = new Map<number, InternalClient>();
  private nextId = 1;
  private readonly logger: Logger;
  private readonly maxBufferBytes: number;

  constructor(
    private readonly gateway: Gateway,
    private readonly options: WsServerOptions
  ) {
    this.logger = (options.logger ?? noopLogger).child('ws');
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  }

  attach(server: http.Server): void {
    server.on('upgrade', (req, socket, head) => {
      try {
        const url = new URL(req.url ?? '/', 'http://local');
        if (url.pathname !== this.options.path) {
          socket.destroy();
          return;
        }
        if (req.headers['upgrade']?.toLowerCase() !== 'websocket') {
          socket.destroy();
          return;
        }
        const key = req.headers['sec-websocket-key'];
        if (typeof key !== 'string') {
          socket.destroy();
          return;
        }
        const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
        const responseHeaders = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`
        ];
        socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
        if (head.length) socket.unshift(head);

        const authHeader = req.headers.authorization;
        const authorized = !this.options.authToken
          || (typeof authHeader === 'string'
              && authHeader.startsWith('Bearer ')
              && authHeader.slice(7).trim() === this.options.authToken);

        this.attachSocket(socket as Duplex, authorized);
      } catch (error) {
        this.logger.warn('upgrade failed', {
          error: error instanceof Error ? error.message : String(error)
        });
        try { socket.destroy(); } catch { /* ignore */ }
      }
    });
  }

  broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const client of this.clients.values()) {
      if (client.authorized) client.send(text);
    }
  }

  size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try { client.close(1001, 'server-shutdown'); } catch { /* ignore */ }
    }
    this.clients.clear();
  }

  private attachSocket(socket: Duplex, authorized: boolean): void {
    const id = this.nextId++;
    const client: InternalClient = {
      id, socket,
      buffer: Buffer.alloc(0),
      authorized,
      send: (text: string) => this.sendFrame(socket, OP_TEXT, Buffer.from(text, 'utf8')),
      close: (code = 1000, reason = '') => {
        const reasonBuf = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
        this.sendFrame(socket, OP_CLOSE, payload);
        socket.end();
      }
    };
    this.clients.set(id, client);
    this.logger.debug('ws connect', { id, authorized });

    socket.on('data', (chunk: Buffer) => {
      if (client.buffer.length + chunk.length > this.maxBufferBytes) {
        this.logger.warn('ws buffer overflow', { id });
        client.close(1009, 'buffer overflow');
        this.clients.delete(id);
        return;
      }
      client.buffer = Buffer.concat([client.buffer, chunk]);
      this.drain(client);
    });
    socket.on('close', () => {
      this.clients.delete(id);
      this.logger.debug('ws disconnect', { id });
    });
    socket.on('error', (error) => {
      this.logger.debug('ws socket error', {
        id, error: error instanceof Error ? error.message : String(error)
      });
      this.clients.delete(id);
    });

    if (authorized) {
      client.send(JSON.stringify({ type: 'hello', version: GARUD_VERSION }));
    } else {
      client.send(JSON.stringify({ type: 'hello', version: GARUD_VERSION, authRequired: true }));
    }
  }

  private drain(client: InternalClient): void {
    while (client.buffer.length >= 2) {
      const first = client.buffer[0]!;
      const second = client.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLen = second & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (client.buffer.length < offset + 2) return;
        payloadLen = client.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (client.buffer.length < offset + 8) return;
        const big = client.buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          client.close(1009, 'frame too large');
          return;
        }
        payloadLen = Number(big);
        offset += 8;
      }

      let mask: Buffer | undefined;
      if (masked) {
        if (client.buffer.length < offset + 4) return;
        mask = client.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (client.buffer.length < offset + payloadLen) return;

      const rawPayload = client.buffer.slice(offset, offset + payloadLen);
      const payload = mask ? Buffer.alloc(payloadLen) : rawPayload;
      if (mask) {
        for (let i = 0; i < payloadLen; i++) payload[i] = rawPayload[i]! ^ mask[i % 4]!;
      }
      client.buffer = client.buffer.slice(offset + payloadLen);

      if (!fin && opcode !== OP_CONTINUATION) {
        client.close(1003, 'fragmented frames not supported');
        return;
      }

      if (opcode === OP_CLOSE) {
        client.close(1000, 'bye');
        return;
      }
      if (opcode === OP_PING) {
        this.sendFrame(client.socket, OP_PONG, payload);
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_TEXT) {
        void this.handleMessage(client, payload.toString('utf8'));
        continue;
      }
      if (opcode === OP_BINARY) {
        client.close(1003, 'binary frames not supported');
        return;
      }
    }
  }

  private async handleMessage(client: InternalClient, text: string): Promise<void> {
    let payload: unknown;
    try { payload = JSON.parse(text); } catch {
      client.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
      return;
    }
    const obj = payload as { type?: string; token?: string } & IncomingMessage;
    if (obj.type === 'auth') {
      if (this.options.authToken && obj.token === this.options.authToken) {
        client.authorized = true;
        client.send(JSON.stringify({ type: 'auth-ok' }));
      } else {
        client.send(JSON.stringify({ type: 'error', error: 'auth failed' }));
      }
      return;
    }
    if (!client.authorized) {
      client.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
      return;
    }
    if (obj.type === 'ping') {
      client.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }
    if (obj.type === 'message') {
      const message: IncomingMessage = {
        channel: obj.channel,
        userId: obj.userId,
        text: obj.text,
        trustLevel: obj.trustLevel as TrustLevel | undefined,
        agentId: obj.agentId,
        clientId: obj.clientId,
        requestId: obj.requestId
      };
      try {
        const result = await this.gateway.handleDetailed(message, { noDeliver: true });
        client.send(JSON.stringify({
          type: 'reply',
          requestId: result.requestId,
          reply: result.reply,
          duplicate: result.duplicate ?? false,
          rateLimited: result.rateLimited ?? false
        }));
      } catch (error) {
        client.send(JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        }));
      }
      return;
    }
    client.send(JSON.stringify({ type: 'error', error: `unknown type: ${obj.type}` }));
  }

  private sendFrame(socket: Duplex, opcode: number, payload: Buffer): void {
    if (socket.destroyed) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      socket.write(Buffer.concat([header, payload]));
    } catch { /* ignore broken pipe */ }
  }
}
