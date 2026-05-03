import { randomBytes } from 'node:crypto';
import { PairingRecord, TrustLevel } from '../types.js';

export interface PairingStoreOptions {
  codeTtlMs?: number;
  codeBytes?: number;
}

/**
 * Issues short-lived pairing codes that elevate a (channel, user) pair to a
 * given trust level when redeemed.
 */
export class PairingStore {
  private readonly records = new Map<string, PairingRecord>();
  private nowProvider: () => number = () => Date.now();
  private readonly codeTtlMs: number;
  private readonly codeBytes: number;

  constructor(options: PairingStoreOptions = {}) {
    this.codeTtlMs = options.codeTtlMs ?? 10 * 60_000;
    this.codeBytes = options.codeBytes ?? 4;
  }

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  issue(channel: string, userId: string, trustLevel: TrustLevel): PairingRecord {
    this.gc();
    const code = randomBytes(this.codeBytes).toString('hex');
    const now = this.nowProvider();
    const record: PairingRecord = {
      code, channel, userId, trustLevel,
      createdAt: now,
      expiresAt: now + this.codeTtlMs
    };
    for (const existing of [...this.records.values()]) {
      if (existing.channel === channel && existing.userId === userId) {
        this.records.delete(existing.code);
      }
    }
    this.records.set(code, record);
    return record;
  }

  redeem(code: string): PairingRecord | undefined {
    this.gc();
    const record = this.records.get(code.trim().toLowerCase());
    if (!record) return undefined;
    if (this.nowProvider() > record.expiresAt) {
      this.records.delete(record.code);
      return undefined;
    }
    this.records.delete(record.code);
    return record;
  }

  /** Revoke any pending code for the given (channel, user). Returns count. */
  revoke(channel: string, userId: string): number {
    let removed = 0;
    for (const [code, record] of [...this.records.entries()]) {
      if (record.channel === channel && record.userId === userId) {
        this.records.delete(code);
        removed += 1;
      }
    }
    return removed;
  }

  list(): PairingRecord[] {
    this.gc();
    return [...this.records.values()];
  }

  size(): number {
    this.gc();
    return this.records.size;
  }

  private gc(): void {
    const now = this.nowProvider();
    for (const [code, record] of this.records) {
      if (record.expiresAt < now) this.records.delete(code);
    }
  }
}
