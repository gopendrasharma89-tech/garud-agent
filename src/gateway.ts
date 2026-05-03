import { AgentRuntime } from './agent/agent-runtime.js';
import { ToolCache } from './cache/tool-cache.js';
import { ConversationStore } from './conversation/conversation-store.js';
import { AuditLogger } from './core/audit-log.js';
import { EventBus } from './core/event-bus.js';
import { MemoryStore } from './core/memory-store.js';
import { PairingStore } from './core/pairing-store.js';
import { PolicyEngine } from './core/policy-engine.js';
import { RateLimiter, RateLimitResult } from './core/rate-limiter.js';
import { SessionStore } from './core/session-store.js';
import { ToolRegistry } from './core/tool-registry.js';
import { MetricsRegistry } from './metrics/registry.js';
import { ToolQuotaManager } from './quotas/tool-quota.js';
import { JsonFileStore } from './storage/json-store.js';
import { AgentReply, ChannelAdapter, IncomingMessage, Logger, TrustLevel } from './types.js';
import { noopLogger } from './utils/logger.js';
import { newRequestId } from './utils/request-id.js';

interface GatewayEvents {
  received: IncomingMessage;
  replied: { sessionId: string; text: string; requestId?: string };
  rateLimited: { channel: string; userId: string };
  policyBlocked: { sessionId: string; tool: string; reason: string };
  pairingIssued: { code: string; channel: string; userId: string };
  pairingRedeemed: { channel: string; userId: string; trustLevel: TrustLevel };
  shutdown: { reason: string };
}

export interface GatewayDeps {
  sessions?: SessionStore;
  memories?: MemoryStore;
  tools?: ToolRegistry;
  policy?: PolicyEngine;
  rateLimiter?: RateLimiter;
  audit?: AuditLogger;
  store?: JsonFileStore;
  pairing?: PairingStore;
  cache?: ToolCache;
  quotas?: ToolQuotaManager;
  conversation?: ConversationStore;
  metrics?: MetricsRegistry;
  logger?: Logger;
  /** When true, persist after every successful turn. */
  autoPersist?: boolean;
}

export interface SendOptions {
  noDeliver?: boolean;
  signal?: AbortSignal;
  requestId?: string;
}

export interface GatewayHandleResult {
  reply: AgentReply;
  rateLimit?: RateLimitResult;
  duplicate?: boolean;
  rateLimited?: boolean;
  requestId: string;
}

export class Gateway {
  readonly events = new EventBus<GatewayEvents>();
  readonly sessions: SessionStore;
  readonly memories: MemoryStore;
  readonly tools?: ToolRegistry;
  readonly policy?: PolicyEngine;
  readonly rateLimiter?: RateLimiter;
  readonly audit?: AuditLogger;
  readonly pairing?: PairingStore;
  readonly cache?: ToolCache;
  readonly quotas?: ToolQuotaManager;
  readonly conversation?: ConversationStore;
  readonly metrics?: MetricsRegistry;
  readonly channels = new Map<string, ChannelAdapter>();
  private readonly store?: JsonFileStore;
  private readonly logger: Logger;
  private readonly autoPersist: boolean;
  private readonly seenClientIds = new Map<string, number>();
  private stats = { handled: 0, rateLimited: 0, duplicates: 0, errors: 0 };

  constructor(private readonly runtime: AgentRuntime, deps: GatewayDeps = {}) {
    this.sessions = deps.sessions ?? new SessionStore();
    this.memories = deps.memories ?? new MemoryStore();
    this.tools = deps.tools;
    this.policy = deps.policy;
    this.rateLimiter = deps.rateLimiter;
    this.audit = deps.audit;
    this.store = deps.store;
    this.pairing = deps.pairing;
    this.cache = deps.cache;
    this.quotas = deps.quotas;
    this.conversation = deps.conversation;
    this.metrics = deps.metrics;
    this.logger = deps.logger ?? noopLogger;
    this.autoPersist = deps.autoPersist ?? true;
    this.events.setErrorHandler((event, error) => {
      this.logger.warn('event handler error', {
        event: String(event),
        error: error instanceof Error ? error.message : String(error)
      });
    });
    this.registerMetrics();
  }

  private registerMetrics(): void {
    if (!this.metrics) return;
    this.metrics.counter('garud_messages_total', 'Total messages handled');
    this.metrics.counter('garud_messages_failed_total', 'Total messages that errored');
    this.metrics.counter('garud_messages_rate_limited_total', 'Total messages rate-limited');
    this.metrics.counter('garud_messages_duplicate_total', 'Total deduplicated messages');
    this.metrics.gauge('garud_sessions', 'Active sessions');
    this.metrics.gauge('garud_memories', 'Stored memories');
    this.metrics.histogram('garud_turn_duration_ms', 'Latency of agent turns in ms',
      [10, 25, 50, 100, 250, 500, 1000, 2500, 5000]);
  }

  getRuntime(): AgentRuntime { return this.runtime; }

  /** Update gauges for metrics scrapers without other side effects. */
  refreshGauges(): void {
    if (!this.metrics) return;
    this.metrics.set('garud_sessions', this.sessions.size());
    this.metrics.set('garud_memories', this.memories.size());
  }

  getStats(): {
    handled: number; rateLimited: number; duplicates: number; errors: number;
    sessions: number; memories: number;
    cache?: ReturnType<ToolCache['stats']>;
    conversations?: number;
    quotas?: number;
  } {
    this.refreshGauges();
    return {
      ...this.stats,
      sessions: this.sessions.size(),
      memories: this.memories.size(),
      cache: this.cache?.stats(),
      conversations: this.conversation?.size(),
      quotas: this.quotas?.size()
    };
  }

  registerChannel(channel: ChannelAdapter): void {
    if (this.channels.has(channel.name)) {
      throw new Error(`Channel already registered: ${channel.name}`);
    }
    this.channels.set(channel.name, channel);
  }

  upsertChannel(channel: ChannelAdapter): void {
    this.channels.set(channel.name, channel);
  }

  unregisterChannel(name: string): boolean {
    return this.channels.delete(name);
  }

  async loadFromDisk(): Promise<void> {
    if (!this.store) return;
    const snapshot = await this.store.load();
    this.sessions.hydrate(snapshot.sessions);
    this.memories.hydrate(snapshot.memories);
    if (this.conversation && snapshot.conversations) {
      this.conversation.hydrate(snapshot.conversations);
    }
    this.logger.info('state loaded', {
      sessions: snapshot.sessions.length,
      memories: snapshot.memories.length,
      conversations: snapshot.conversations?.length ?? 0
    });
  }

  async persist(): Promise<void> {
    if (!this.store) return;
    await this.store.save({
      sessions: this.sessions.list(),
      memories: this.memories.list(),
      conversations: this.conversation
        ? this.sessions.list().flatMap((s) => this.conversation!.list(s.id))
        : []
    });
  }

  issuePairing(channel: string, userId: string, trustLevel: TrustLevel): { code: string; expiresAt: number } | undefined {
    if (!this.pairing) return undefined;
    const record = this.pairing.issue(channel, userId, trustLevel);
    this.events.emit('pairingIssued', { code: record.code, channel, userId });
    void this.safeAudit('pairing', { action: 'issued', channel, userId, trustLevel });
    return { code: record.code, expiresAt: record.expiresAt };
  }

  redeemPairing(code: string): { ok: boolean; trustLevel?: TrustLevel; channel?: string; userId?: string } {
    if (!this.pairing) return { ok: false };
    const record = this.pairing.redeem(code);
    if (!record) return { ok: false };
    this.sessions.setTrust(record.channel, record.userId, record.trustLevel);
    this.events.emit('pairingRedeemed', {
      channel: record.channel, userId: record.userId, trustLevel: record.trustLevel
    });
    void this.safeAudit('pairing', { action: 'redeemed', ...record });
    return {
      ok: true,
      trustLevel: record.trustLevel,
      channel: record.channel,
      userId: record.userId
    };
  }

  revokePairing(channel: string, userId: string): number {
    if (!this.pairing) return 0;
    const removed = this.pairing.revoke(channel, userId);
    if (removed > 0) void this.safeAudit('pairing', { action: 'revoked', channel, userId, removed });
    return removed;
  }

  async handle(message: IncomingMessage, options: SendOptions = {}): Promise<AgentReply> {
    const result = await this.handleDetailed(message, options);
    return result.reply;
  }

  async handleDetailed(message: IncomingMessage, options: SendOptions = {}): Promise<GatewayHandleResult> {
    const requestId = options.requestId ?? message.requestId ?? newRequestId();
    if (!message.channel || typeof message.channel !== 'string') {
      this.stats.errors += 1;
      this.metrics?.inc('garud_messages_failed_total');
      throw new Error('message.channel is required');
    }
    if (!message.userId || typeof message.userId !== 'string') {
      this.stats.errors += 1;
      this.metrics?.inc('garud_messages_failed_total');
      throw new Error('message.userId is required');
    }
    if (!message.text || !message.text.trim()) {
      this.stats.errors += 1;
      this.metrics?.inc('garud_messages_failed_total');
      throw new Error('message.text is required');
    }
    if (message.clientId && this.isDuplicate(message.clientId)) {
      this.stats.duplicates += 1;
      this.metrics?.inc('garud_messages_duplicate_total');
      const session = this.sessions.getByUser(message.channel, message.userId, message.agentId);
      const fallback: AgentReply = {
        text: 'duplicate request ignored',
        notes: ['dedup'], usedTools: [], usedMemories: [], requestId
      };
      await this.safeAudit('system', { dedup: message.clientId }, session?.id, requestId);
      return { reply: fallback, duplicate: true, requestId };
    }

    const channel = this.channels.get(message.channel);
    if (!channel && !options.noDeliver) {
      this.stats.errors += 1;
      this.metrics?.inc('garud_messages_failed_total');
      throw new Error(`Channel not registered: ${message.channel}`);
    }

    const session = this.sessions.getOrCreate(message);
    let rateLimit: RateLimitResult | undefined;

    if (this.rateLimiter) {
      rateLimit = this.rateLimiter.allow(`${message.channel}:${message.userId}`);
      if (!rateLimit.allowed) {
        this.stats.rateLimited += 1;
        this.metrics?.inc('garud_messages_rate_limited_total');
        this.events.emit('rateLimited', { channel: message.channel, userId: message.userId });
        await this.safeAudit('system', {
          rateLimited: true, resetAt: rateLimit.resetAt
        }, session.id, requestId);
        const reply: AgentReply = {
          text: `rate limit exceeded; retry after ${Math.ceil((rateLimit.resetAt - Date.now()) / 1000)}s`,
          notes: ['rate-limited'], usedTools: [], usedMemories: [], requestId
        };
        if (channel && !options.noDeliver) await channel.deliver(session, reply);
        return { reply, rateLimit, rateLimited: true, requestId };
      }
    }

    this.events.emit('received', { ...message, requestId });
    await this.safeAudit('message', {
      channel: message.channel,
      userId: message.userId,
      agentId: session.agentId,
      preview: message.text.slice(0, 200)
    }, session.id, requestId);

    const startedAt = Date.now();
    let reply: AgentReply;
    try {
      reply = await this.runtime.reply(session, message.text, options.signal, requestId);
    } catch (error) {
      this.stats.errors += 1;
      this.metrics?.inc('garud_messages_failed_total');
      const errMsg = error instanceof Error ? error.message : String(error);
      await this.safeAudit('error', { message: errMsg }, session.id, requestId);
      throw error;
    }

    if (channel && !options.noDeliver) {
      await channel.deliver(session, reply);
    }

    this.stats.handled += 1;
    this.metrics?.inc('garud_messages_total');
    this.metrics?.observe('garud_turn_duration_ms', Date.now() - startedAt);
    this.events.emit('replied', { sessionId: session.id, text: reply.text, requestId });

    if (this.autoPersist) {
      this.persist().catch((err) => this.logger.warn('persist failed', {
        error: err instanceof Error ? err.message : String(err)
      }));
    }

    return { reply, rateLimit, requestId };
  }

  async shutdown(reason = 'graceful'): Promise<void> {
    this.events.emit('shutdown', { reason });
    for (const channel of this.channels.values()) {
      try {
        await channel.shutdown?.();
      } catch {
        // ignore
      }
    }
    await this.persist().catch(() => undefined);
  }

  private isDuplicate(clientId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of this.seenClientIds) {
      if (now - ts > 60_000) this.seenClientIds.delete(id);
    }
    if (this.seenClientIds.has(clientId)) return true;
    this.seenClientIds.set(clientId, now);
    return false;
  }

  private async safeAudit(
    kind: Parameters<NonNullable<GatewayDeps['audit']>['record']>[0],
    detail: Record<string, unknown>,
    sessionId?: string,
    requestId?: string
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.record(kind, detail, sessionId, requestId);
    } catch (error) {
      this.logger.warn('audit failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
