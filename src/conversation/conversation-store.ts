import { ConversationTurn } from '../types.js';

export interface ConversationStoreOptions {
  /** Max turns kept per session; 0 disables. */
  maxTurns?: number;
}

/**
 * Per-session conversation history, capped to a configurable depth. The
 * brain's compose context can pull the last N turns for continuity.
 */
export class ConversationStore {
  private readonly turns = new Map<string, ConversationTurn[]>();
  private readonly maxTurns: number;
  private nowProvider: () => number = () => Date.now();

  constructor(options: ConversationStoreOptions = {}) {
    this.maxTurns = Math.max(0, options.maxTurns ?? 50);
  }

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  append(turn: Omit<ConversationTurn, 'ts'> & { ts?: number }): ConversationTurn {
    const enriched: ConversationTurn = {
      ...turn,
      ts: turn.ts ?? this.nowProvider()
    };
    if (this.maxTurns === 0) return enriched;
    const existing = this.turns.get(turn.sessionId) ?? [];
    existing.push(enriched);
    while (existing.length > this.maxTurns) existing.shift();
    this.turns.set(turn.sessionId, existing);
    return enriched;
  }

  list(sessionId: string, limit?: number): ConversationTurn[] {
    const all = this.turns.get(sessionId) ?? [];
    if (!limit || limit >= all.length) return [...all];
    return all.slice(-limit);
  }

  recent(sessionId: string, limit: number): ConversationTurn[] {
    return this.list(sessionId, limit);
  }

  clear(sessionId: string): number {
    const existing = this.turns.get(sessionId);
    if (!existing) return 0;
    const removed = existing.length;
    this.turns.delete(sessionId);
    return removed;
  }

  size(): number {
    let total = 0;
    for (const arr of this.turns.values()) total += arr.length;
    return total;
  }

  /** Hydrate from a JSONL or array snapshot. */
  hydrate(turns: ConversationTurn[]): void {
    this.turns.clear();
    for (const turn of turns) {
      const arr = this.turns.get(turn.sessionId) ?? [];
      arr.push(turn);
      this.turns.set(turn.sessionId, arr);
    }
    if (this.maxTurns > 0) {
      for (const [sid, arr] of this.turns) {
        while (arr.length > this.maxTurns) arr.shift();
        this.turns.set(sid, arr);
      }
    }
  }
}
