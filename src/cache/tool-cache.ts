import { createHash } from 'node:crypto';
import { ToolResult } from '../types.js';

export interface ToolCacheOptions {
  enabled?: boolean;
  ttlMs?: number;
  maxEntries?: number;
}

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
}

/**
 * Simple TTL+LRU cache for tool results. Keyed by tool name + input hash.
 */
export class ToolCache {
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private nowProvider: () => number = () => Date.now();
  private hits = 0;
  private misses = 0;

  constructor(options: ToolCacheOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 200);
  }

  setTimeProvider(provider: () => number): void {
    this.nowProvider = provider;
  }

  private key(toolName: string, input: string): string {
    return toolName + ':' + createHash('sha1').update(input).digest('hex');
  }

  get(toolName: string, input: string): ToolResult | undefined {
    if (!this.enabled) return undefined;
    const key = this.key(toolName, input);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.nowProvider() > entry.expiresAt) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.result;
  }

  set(toolName: string, input: string, result: ToolResult): void {
    if (!this.enabled || result.error) return;
    const key = this.key(toolName, input);
    this.entries.set(key, {
      result,
      expiresAt: this.nowProvider() + this.ttlMs
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Invalidate a specific entry; returns whether anything was removed. */
  delete(toolName: string, input: string): boolean {
    return this.entries.delete(this.key(toolName, input));
  }

  /** Invalidate every entry for a tool. */
  invalidateTool(toolName: string): number {
    const prefix = toolName + ':';
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  size(): number {
    return this.entries.size;
  }

  stats(): { hits: number; misses: number; size: number; enabled: boolean } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size, enabled: this.enabled };
  }
}
