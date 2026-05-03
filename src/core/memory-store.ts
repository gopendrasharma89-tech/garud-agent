import { randomUUID } from 'node:crypto';
import { Memory } from '../types.js';
import { jaccard, ngrams, tokenize } from '../utils/text.js';

export interface MemorySearchResult {
  memory: Memory;
  score: number;
}

export interface MemoryStoreOptions {
  /** Maximum number of memories to retain per session (oldest evicted first). */
  maxPerSession?: number;
  /** Soft duplicate Jaccard threshold; 0 disables dedup on save. */
  dedupThreshold?: number;
}

export interface MemorySearchOptions {
  limit?: number;
  tags?: string[];
  minScore?: number;
  fuzzy?: boolean;
  /** Include expired memories (default: false). */
  includeExpired?: boolean;
}

export interface MemorySaveOptions {
  tags?: string[];
  importance?: number;
  /** Pinned memories are never evicted by capacity. */
  pinned?: boolean;
  /** Optional absolute expiry timestamp. */
  expiresAt?: number;
  /** Optional relative TTL in milliseconds. */
  ttlMs?: number;
}

/**
 * In-memory store for session memories with token-based retrieval, fuzzy
 * matching, pinning, TTL expiration, and near-duplicate deduplication.
 */
export class MemoryStore {
  private readonly items: Memory[] = [];
  private readonly byId = new Map<string, Memory>();
  private readonly maxPerSession: number;
  private readonly dedupThreshold: number;
  private nowProvider: () => number = () => Date.now();

  constructor(options: MemoryStoreOptions = {}) {
    const limit = options.maxPerSession ?? 1000;
    this.maxPerSession = limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
    this.dedupThreshold = Math.max(0, Math.min(1, options.dedupThreshold ?? 0));
  }

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  save(sessionId: string, text: string, tagsOrOptions: string[] | MemorySaveOptions = [], importance = 0.5): Memory {
    if (!text || !text.trim()) throw new Error('Memory text cannot be empty');
    const opts: MemorySaveOptions = Array.isArray(tagsOrOptions)
      ? { tags: tagsOrOptions, importance }
      : tagsOrOptions;
    const tags = opts.tags ?? [];
    const importanceVal = opts.importance ?? importance;
    const clamped = Math.max(0, Math.min(1, importanceVal));

    // Near-duplicate detection.
    if (this.dedupThreshold > 0) {
      const queryGrams = ngrams(text);
      for (const m of this.items) {
        if (m.sessionId !== sessionId) continue;
        const sim = jaccard(ngrams(m.text), queryGrams);
        if (sim >= this.dedupThreshold) {
          // Update timestamp + importance instead of duplicating.
          m.importance = Math.max(m.importance, clamped);
          m.createdAt = this.nowProvider();
          return m;
        }
      }
    }

    const now = this.nowProvider();
    let expiresAt: number | undefined;
    if (opts.expiresAt !== undefined) expiresAt = opts.expiresAt;
    else if (opts.ttlMs !== undefined && opts.ttlMs > 0) expiresAt = now + opts.ttlMs;

    const memory: Memory = {
      id: randomUUID(),
      sessionId,
      text: text.trim(),
      tags: [...new Set(tags.map((t) => t.toLowerCase().trim()).filter(Boolean))],
      importance: clamped,
      createdAt: now,
      tokens: tokenize(text),
      pinned: opts.pinned ?? false,
      ...(expiresAt !== undefined ? { expiresAt } : {})
    };
    this.items.push(memory);
    this.byId.set(memory.id, memory);
    this.evictIfNeeded(sessionId);
    return memory;
  }

  hydrate(memories: Memory[]): void {
    this.items.length = 0;
    this.byId.clear();
    for (const memory of memories) {
      const m: Memory = { ...memory, tokens: memory.tokens ?? tokenize(memory.text) };
      this.items.push(m);
      this.byId.set(m.id, m);
    }
  }

  list(sessionId?: string, includeExpired = false): Memory[] {
    const now = this.nowProvider();
    const filtered = sessionId
      ? this.items.filter((m) => m.sessionId === sessionId)
      : [...this.items];
    if (includeExpired) return filtered;
    return filtered.filter((m) => !m.expiresAt || m.expiresAt > now);
  }

  get(memoryId: string): Memory | undefined {
    const m = this.byId.get(memoryId);
    if (!m) return undefined;
    if (m.expiresAt && m.expiresAt <= this.nowProvider()) return undefined;
    return m;
  }

  remove(memoryId: string): boolean {
    const idx = this.items.findIndex((m) => m.id === memoryId);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this.byId.delete(memoryId);
    return true;
  }

  /** Toggle pinned flag and return the updated memory. */
  pin(memoryId: string, pinned: boolean): Memory | undefined {
    const m = this.byId.get(memoryId);
    if (!m) return undefined;
    m.pinned = pinned;
    return m;
  }

  search(sessionId: string, query: string, limit = 5): Memory[] {
    return this.searchWithScores(sessionId, query, { limit }).map((r) => r.memory);
  }

  searchAll(query: string, limit = 10, options: Omit<MemorySearchOptions, 'limit'> = {}): MemorySearchResult[] {
    const queryTerms = new Set(tokenize(query));
    const queryGrams = options.fuzzy ? ngrams(query) : [];
    const minScore = options.minScore ?? 0;
    const tagFilter = options.tags?.map((t) => t.toLowerCase());
    const now = this.nowProvider();
    const includeExpired = options.includeExpired ?? false;

    return this.items
      .filter((m) => includeExpired || !m.expiresAt || m.expiresAt > now)
      .filter((m) => !tagFilter?.length || tagFilter.some((t) => m.tags.includes(t)))
      .map((memory) => this.scoreMemory(memory, queryTerms, queryGrams, now, !!options.fuzzy))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit));
  }

  searchWithScores(
    sessionId: string,
    query: string,
    options: MemorySearchOptions = {}
  ): MemorySearchResult[] {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0;
    const queryTerms = new Set(tokenize(query));
    const queryGrams = options.fuzzy ? ngrams(query) : [];
    const tagFilter = options.tags?.map((t) => t.toLowerCase());
    const now = this.nowProvider();
    const includeExpired = options.includeExpired ?? false;

    return this.items
      .filter((m) => m.sessionId === sessionId)
      .filter((m) => includeExpired || !m.expiresAt || m.expiresAt > now)
      .filter((m) => !tagFilter?.length || tagFilter.some((t) => m.tags.includes(t)))
      .map((memory) => this.scoreMemory(memory, queryTerms, queryGrams, now, !!options.fuzzy))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit));
  }

  private scoreMemory(
    memory: Memory,
    queryTerms: Set<string>,
    queryGrams: string[],
    now: number,
    fuzzy: boolean
  ): MemorySearchResult {
    const tokens = memory.tokens ?? tokenize(memory.text);
    const overlap = tokens.filter((t) => queryTerms.has(t)).length;
    const ageMs = Math.max(1, now - memory.createdAt);
    const recencyBoost = 1 / Math.log10(10 + ageMs / 1000);
    let score = overlap * 2 + memory.importance * 3 + recencyBoost;
    if (memory.pinned) score += 2;
    if (fuzzy && queryGrams.length) {
      score += jaccard(ngrams(memory.text), queryGrams) * 4;
    }
    return { memory, score };
  }

  clearSession(sessionId: string): number {
    const before = this.items.length;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i]!;
      if (m.sessionId === sessionId) {
        this.items.splice(i, 1);
        this.byId.delete(m.id);
      }
    }
    return before - this.items.length;
  }

  /** Drop expired memories proactively. Returns the number removed. */
  pruneExpired(): number {
    const now = this.nowProvider();
    let removed = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i]!;
      if (m.expiresAt && m.expiresAt <= now) {
        this.items.splice(i, 1);
        this.byId.delete(m.id);
        removed += 1;
      }
    }
    return removed;
  }

  importMemories(memories: unknown[], options: { skipConflicts?: boolean } = {}): number {
    const skip = options.skipConflicts ?? true;
    let inserted = 0;
    for (const raw of memories) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Partial<Memory>;
      if (typeof m.id !== 'string' || typeof m.sessionId !== 'string'
          || typeof m.text !== 'string' || !m.text.trim()
          || typeof m.createdAt !== 'number') continue;
      if (skip && this.byId.has(m.id)) continue;
      const memory: Memory = {
        id: m.id,
        sessionId: m.sessionId,
        text: m.text,
        tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string') as string[] : [],
        importance: typeof m.importance === 'number'
          ? Math.max(0, Math.min(1, m.importance))
          : 0.5,
        createdAt: m.createdAt,
        ...(typeof m.expiresAt === 'number' ? { expiresAt: m.expiresAt } : {}),
        ...(m.pinned ? { pinned: true } : {}),
        tokens: tokenize(m.text)
      };
      this.items.push(memory);
      this.byId.set(memory.id, memory);
      inserted += 1;
    }
    return inserted;
  }

  size(): number {
    return this.items.length;
  }

  private evictIfNeeded(sessionId: string): void {
    if (this.maxPerSession === Number.MAX_SAFE_INTEGER) return;
    const sessionMemories = this.items
      .filter((m) => m.sessionId === sessionId && !m.pinned)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (sessionMemories.length > this.maxPerSession) {
      const evicted = sessionMemories.shift();
      if (!evicted) break;
      const idx = this.items.indexOf(evicted);
      if (idx !== -1) this.items.splice(idx, 1);
      this.byId.delete(evicted.id);
    }
  }
}
