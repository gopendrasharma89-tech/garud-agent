import { randomUUID } from 'node:crypto';
import { IncomingMessage, Session, SessionRole, TrustLevel } from '../types.js';

const TRUST_RANK: Record<TrustLevel, number> = {
  blocked: 0,
  guest: 1,
  trusted: 2,
  owner: 3
};

const RESERVED_SETTING_PREFIX = '_internal.';

export interface SessionStoreOptions {
  defaultAgentId?: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly byId = new Map<string, Session>();
  private nowProvider: () => number = () => Date.now();
  private readonly defaultAgentId: string;

  constructor(options: SessionStoreOptions = {}) {
    this.defaultAgentId = options.defaultAgentId ?? 'main';
  }

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  private key(channel: string, userId: string, agentId: string): string {
    return `${agentId}::${channel}::${userId}`;
  }

  getOrCreate(message: IncomingMessage, role: SessionRole = 'channel'): Session {
    const agentId = message.agentId ?? this.defaultAgentId;
    const key = this.key(message.channel, message.userId, agentId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.updatedAt = this.nowProvider();
      existing.messageCount += 1;
      if (message.trustLevel && TRUST_RANK[message.trustLevel] >= TRUST_RANK[existing.trustLevel]) {
        existing.trustLevel = message.trustLevel;
      }
      return existing;
    }

    const now = this.nowProvider();
    const session: Session = {
      id: randomUUID(),
      channel: message.channel,
      userId: message.userId,
      trustLevel: message.trustLevel ?? 'guest',
      role,
      agentId,
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      settings: {}
    };
    this.sessions.set(key, session);
    this.byId.set(session.id, session);
    return session;
  }

  hydrate(sessions: Session[]): void {
    this.sessions.clear();
    this.byId.clear();
    for (const raw of sessions) {
      const session: Session = {
        ...raw,
        agentId: raw.agentId ?? this.defaultAgentId,
        settings: raw.settings ?? {}
      };
      this.sessions.set(this.key(session.channel, session.userId, session.agentId), session);
      this.byId.set(session.id, session);
    }
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(sessionId: string): Session | undefined {
    return this.byId.get(sessionId);
  }

  getByUser(channel: string, userId: string, agentId?: string): Session | undefined {
    return this.sessions.get(this.key(channel, userId, agentId ?? this.defaultAgentId));
  }

  setTrust(channel: string, userId: string, trust: TrustLevel, agentId?: string): Session | undefined {
    const session = this.sessions.get(this.key(channel, userId, agentId ?? this.defaultAgentId));
    if (!session) return undefined;
    session.trustLevel = trust;
    session.updatedAt = this.nowProvider();
    return session;
  }

  /** Update a settings field. Reserved internal keys are rejected. */
  setSetting(sessionId: string, key: string, value: unknown): boolean {
    if (key.startsWith(RESERVED_SETTING_PREFIX)) return false;
    const session = this.byId.get(sessionId);
    if (!session) return false;
    session.settings[key] = value;
    session.updatedAt = this.nowProvider();
    return true;
  }

  remove(sessionId: string): boolean {
    const session = this.byId.get(sessionId);
    if (!session) return false;
    this.byId.delete(sessionId);
    this.sessions.delete(this.key(session.channel, session.userId, session.agentId));
    return true;
  }

  pruneIdle(ttlMs: number): number {
    if (ttlMs <= 0) return 0;
    const cutoff = this.nowProvider() - ttlMs;
    let removed = 0;
    for (const [, session] of [...this.sessions.entries()]) {
      if (session.updatedAt < cutoff) {
        if (this.remove(session.id)) removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }
}
