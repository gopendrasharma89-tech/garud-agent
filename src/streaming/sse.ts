import type { ServerResponse } from 'node:http';

/**
 * Minimal Server-Sent Events writer. Used by `POST /chat/stream` to stream
 * brain replies token-by-token (or chunk-by-chunk for non-streaming brains).
 *
 * Wire format:
 *   event: token
 *   data: {"text":"Hello"}
 *
 *   event: done
 *   data: {"requestId":"..."}
 *
 * Keepalive: a `: ping` comment is sent every 15s so proxies don't drop the
 * connection mid-stream.
 */

export interface SseWriter {
  /** Send a typed event. */
  event(name: string, data: unknown): void;
  /** Send a default-typed (`message`) event. */
  data(data: unknown): void;
  /** Close the stream. */
  close(): void;
  /** Whether the underlying response is still writable. */
  alive(): boolean;
}

export function openSse(res: ServerResponse, init: { requestId?: string } = {}): SseWriter {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  });
  // Send an immediate comment so clients see the connection opened.
  res.write(`: garud sse open ${init.requestId ?? ''}\n\n`);

  const keepalive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }
  }, 15_000);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    try { res.end(); } catch { /* ignore */ }
  };
  res.on('close', finish);
  res.on('error', finish);

  return {
    event(name, data) {
      if (closed) return;
      try {
        res.write(`event: ${name}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { finish(); }
    },
    data(d) {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch { finish(); }
    },
    close: finish,
    alive() { return !closed && !res.writableEnded && !res.destroyed; }
  };
}

/**
 * Helper: stream an async iterable of chunks to an SSE writer with a final
 * `done` event. Catches errors and emits an `error` event.
 */
export async function pipeToSse(writer: SseWriter, source: AsyncIterable<string>, opts: { requestId?: string } = {}): Promise<void> {
  try {
    for await (const chunk of source) {
      if (!writer.alive()) return;
      writer.event('token', { text: chunk });
    }
    writer.event('done', { requestId: opts.requestId ?? null });
  } catch (e) {
    writer.event('error', { message: (e as Error).message });
  } finally {
    writer.close();
  }
}
