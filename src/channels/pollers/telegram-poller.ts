import { parseTelegram, TelegramUpdate } from '../adapters/telegram-adapter.js';
import type { AgentReply, ChannelAdapter, IncomingMessage, Session } from '../../types.js';

export interface TelegramTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string | number, text: string): Promise<{ ok: boolean; error?: string }>;
}

/** Real transport for api.telegram.org (long-poll getUpdates + sendMessage). */
export class HttpTelegramTransport implements TelegramTransport {
  constructor(private readonly botToken: string, private readonly timeoutSec = 25) {}

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${offset}&timeout=${this.timeoutSec}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
    const body = await res.json() as { ok: boolean; result?: TelegramUpdate[] };
    if (!body.ok) throw new Error('getUpdates returned ok=false');
    return body.result ?? [];
  }

  async sendMessage(chatId: string | number, text: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  }
}

export const TELEGRAM_MAX_MESSAGE = 4096;

/** Split long replies into Telegram-sized chunks. */
export function chunkText(text: string, max = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

export interface TelegramPollerOptions {
  transport: TelegramTransport;
  /** Feed a parsed inbound message into the gateway (usually gateway.handle). */
  handle: (message: IncomingMessage) => Promise<unknown>;
  intervalMs?: number;
  errorBackoffMs?: number;
  channelName?: string;
  onError?: (error: Error) => void;
}

/**
 * Active Telegram connector (OpenClaw-style): long-polls getUpdates without
 * needing a public webhook URL, feeds messages into the gateway, and delivers
 * replies back via sendMessage (with 4096-char chunking).
 *
 * Register it as a gateway channel AND start() the loop:
 *   const poller = new TelegramPoller({ transport, handle: (m) => gateway.handle(m) });
 *   gateway.upsertChannel(poller);
 *   poller.start();
 */
export class TelegramPoller implements ChannelAdapter {
  readonly name: string;
  private offset = 0;
  private running = false;
  private timer?: NodeJS.Timeout;
  private readonly chatByUser = new Map<string, string | number>();
  private readonly counters = { polls: 0, updates: 0, sent: 0, errors: 0 };

  constructor(private readonly options: TelegramPollerOptions) {
    this.name = options.channelName ?? 'telegram';
  }

  getStats(): { polls: number; updates: number; sent: number; errors: number; offset: number; running: boolean } {
    return { ...this.counters, offset: this.offset, running: this.running };
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
  }

  /** One poll cycle; exposed so tests can drive the poller deterministically. */
  async tick(): Promise<number> {
    this.counters.polls += 1;
    const updates = await this.options.transport.getUpdates(this.offset);
    let handled = 0;
    for (const update of updates) {
      if (typeof update.update_id === 'number') this.offset = Math.max(this.offset, update.update_id + 1);
      for (const message of parseTelegram(update)) {
        this.counters.updates += 1;
        const chatId = (message.metadata as { chatId?: string | number } | undefined)?.chatId;
        if (chatId !== undefined) this.chatByUser.set(message.userId, chatId);
        try {
          await this.options.handle({ ...message, channel: this.name });
          handled += 1;
        } catch (error) {
          this.counters.errors += 1;
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    return handled;
  }

  async deliver(session: Session, reply: AgentReply): Promise<void> {
    const chatId = this.chatByUser.get(session.userId) ?? session.userId;
    for (const part of chunkText(reply.text)) {
      const result = await this.options.transport.sendMessage(chatId, part);
      if (result.ok) this.counters.sent += 1;
      else this.counters.errors += 1;
    }
  }

  private loop(): void {
    if (!this.running) return;
    const interval = this.options.intervalMs ?? 1000;
    const backoff = this.options.errorBackoffMs ?? 5000;
    void this.tick()
      .then(() => {
        if (this.running) this.timer = setTimeout(() => this.loop(), interval);
      })
      .catch((error) => {
        this.counters.errors += 1;
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        if (this.running) this.timer = setTimeout(() => this.loop(), backoff);
      });
  }
}
