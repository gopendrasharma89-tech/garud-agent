import { AgentReply, ChannelAdapter, Session } from '../types.js';
import { withTimeout } from '../utils/timeout.js';

/** In-memory channel suitable for testing and the HTTP API echo path. */
export class InMemoryChannel implements ChannelAdapter {
  readonly name: string;
  readonly delivered: Array<{ session: Session; reply: AgentReply; ts: number }> = [];
  private readonly maxHistory: number;

  constructor(name: string, maxHistory = 200) {
    this.name = name;
    this.maxHistory = maxHistory;
  }

  async deliver(session: Session, reply: AgentReply): Promise<void> {
    this.delivered.push({ session, reply, ts: Date.now() });
    while (this.delivered.length > this.maxHistory) this.delivered.shift();
  }

  last(): { session: Session; reply: AgentReply; ts: number } | undefined {
    return this.delivered[this.delivered.length - 1];
  }

  clear(): void {
    this.delivered.length = 0;
  }
}

/** Console channel that prints replies to stdout. */
export class ConsoleChannel implements ChannelAdapter {
  readonly name: string;
  constructor(name = 'console') {
    this.name = name;
  }
  deliver(session: Session, reply: AgentReply): void {
    process.stdout.write(`\n[${this.name}:${session.userId}] ${reply.text}\n`);
  }
}

export interface WebhookChannelOptions {
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** Webhook channel that POSTs replies to a remote URL. */
export class WebhookChannel implements ChannelAdapter {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  readonly name: string;

  constructor(name: string, options: WebhookChannelOptions) {
    this.name = name;
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.headers = options.headers ?? {};
  }

  async deliver(session: Session, reply: AgentReply): Promise<void> {
    if (!globalThis.fetch) return;
    try {
      await withTimeout(globalThis.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({ session, reply })
      }), this.timeoutMs);
    } catch {
      // swallow webhook errors so they don't crash the runtime
    }
  }
}

/** Buffered channel: collects replies and lets you await them. */
export class BufferedChannel implements ChannelAdapter {
  readonly name: string;
  private readonly waiters: Array<(value: AgentReply) => void> = [];
  private readonly buffer: AgentReply[] = [];

  constructor(name: string) {
    this.name = name;
  }

  deliver(_session: Session, reply: AgentReply): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(reply);
    else this.buffer.push(reply);
  }

  next(timeoutMs = 1000): Promise<AgentReply> {
    const buffered = this.buffer.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise<AgentReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('buffered channel timeout')), timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

/** Broadcast channel: fans out replies to multiple subscribers (used by WS). */
export class BroadcastChannel implements ChannelAdapter {
  readonly name: string;
  private readonly subscribers = new Set<(session: Session, reply: AgentReply) => void>();

  constructor(name: string) {
    this.name = name;
  }

  subscribe(handler: (session: Session, reply: AgentReply) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  deliver(session: Session, reply: AgentReply): void {
    for (const handler of this.subscribers) {
      try { handler(session, reply); } catch { /* ignore */ }
    }
  }

  size(): number {
    return this.subscribers.size;
  }
}
