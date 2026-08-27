import type { DmPolicyMode, IncomingMessage, Session, TrustLevel } from '../types.js';

export interface DmVerdict {
  action: 'allow' | 'block' | 'pair';
  reason?: string;
  /** Trust level granted when the pairing code is approved. */
  trustLevel?: TrustLevel;
}

export interface DmPolicyOptions {
  defaultPolicy?: DmPolicyMode;
  channels?: Record<string, DmPolicyMode>;
  allowlist?: Record<string, string[]>;
}

/**
 * OpenClaw-style DM gate. Every inbound message from a non-trusted sender is
 * checked against the channel policy before it can reach the agent:
 *   - open      — anyone may talk (guest trust)
 *   - pairing   — unknown senders receive a pairing code; the owner approves
 *   - allowlist — only pre-listed user ids may talk
 *   - disabled  — the channel accepts no DMs at all
 * Trusted/owner sessions always pass; blocked sessions never do.
 */
export class DmPolicyEngine {
  private readonly defaultPolicy: DmPolicyMode;
  private readonly channels: Record<string, DmPolicyMode>;
  private readonly allowlist = new Map<string, Set<string>>();

  constructor(options: DmPolicyOptions = {}) {
    this.defaultPolicy = options.defaultPolicy ?? 'open';
    this.channels = { ...(options.channels ?? {}) };
    for (const [ch, ids] of Object.entries(options.allowlist ?? {})) {
      this.allowlist.set(ch, new Set(ids));
    }
  }

  policyFor(channel: string): DmPolicyMode {
    return this.channels[channel] ?? this.defaultPolicy;
  }

  setPolicy(channel: string, mode: DmPolicyMode): void {
    this.channels[channel] = mode;
  }

  /** Add a user to a channel allowlist at runtime. */
  allow(channel: string, userId: string): void {
    const set = this.allowlist.get(channel) ?? new Set<string>();
    set.add(userId);
    this.allowlist.set(channel, set);
  }

  isAllowlisted(channel: string, userId: string): boolean {
    return this.allowlist.get(channel)?.has(userId) ?? false;
  }

  describe(): Record<string, unknown> {
    return {
      default: this.defaultPolicy,
      channels: { ...this.channels },
      allowlisted: [...this.allowlist.entries()].map(([ch, ids]) => `${ch}:${ids.size}`)
    };
  }

  evaluate(session: Session, message: Pick<IncomingMessage, 'channel' | 'userId'>): DmVerdict {
    if (session.trustLevel === 'owner' || session.trustLevel === 'trusted') return { action: 'allow' };
    if (session.trustLevel === 'blocked') return { action: 'block', reason: 'user is blocked' };
    const mode = this.policyFor(message.channel);
    switch (mode) {
      case 'open':
        return { action: 'allow' };
      case 'disabled':
        return { action: 'block', reason: `channel ${message.channel} is disabled` };
      case 'allowlist':
        return this.isAllowlisted(message.channel, message.userId)
          ? { action: 'allow' }
          : { action: 'block', reason: 'not on the allowlist for this channel' };
      case 'pairing':
        return { action: 'pair', trustLevel: 'trusted' };
      default:
        return { action: 'allow' };
    }
  }
}
