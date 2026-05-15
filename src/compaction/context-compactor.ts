/**
 * Context-window compactor (OpenClaw-inspired). When the conversation
 * approaches the context budget, the compactor:
 *   1. summarizes the oldest N turns into a single condensed system note
 *   2. prunes low-importance turns
 *   3. flushes any "key facts" to long-term MEMORY.md
 *
 * The summarizer is pluggable — for the deterministic brain a simple
 * heuristic is used; a real LLM brain can override it for higher quality.
 */
export interface Turn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  importance?: number;
  ts?: number;
}

export interface CompactionPlan {
  kept: Turn[];
  summary: string;
  flushed: string[];
  removed: number;
}

export interface CompactorOptions {
  /** Soft character budget. Above this, compact aggressively. */
  budgetChars: number;
  /** Always keep the last N turns verbatim. */
  keepRecent: number;
  /** Importance threshold (0–1) below which a turn may be pruned. */
  pruneBelow: number;
}

export class ContextCompactor {
  constructor(private readonly opts: CompactorOptions = {
    budgetChars: 16_000,
    keepRecent: 6,
    pruneBelow: 0.2
  }) {}

  size(turns: Turn[]): number {
    return turns.reduce((acc, t) => acc + (t.content?.length ?? 0), 0);
  }

  needsCompaction(turns: Turn[]): boolean {
    return this.size(turns) > this.opts.budgetChars;
  }

  /** Produce a compaction plan without mutating the input. */
  plan(turns: Turn[]): CompactionPlan {
    if (!this.needsCompaction(turns)) {
      return { kept: turns, summary: '', flushed: [], removed: 0 };
    }
    const recent = turns.slice(-this.opts.keepRecent);
    const older = turns.slice(0, -this.opts.keepRecent);
    const kept = older.filter((t) => (t.importance ?? 0.5) >= this.opts.pruneBelow);
    const removed = older.length - kept.length;
    const summary = this.summarize(kept);
    // Flush "important" older turns to long-term memory candidates.
    const flushed = older
      .filter((t) => (t.importance ?? 0) >= 0.8 && t.role !== 'system')
      .map((t) => t.content.slice(0, 200));
    return {
      kept: [
        ...(summary ? [{ role: 'system' as const, content: `Earlier conversation summary: ${summary}` }] : []),
        ...recent
      ],
      summary,
      flushed,
      removed: removed + kept.length
    };
  }

  /** Convenience wrapper: returns compacted turn array directly (no metadata). */
  applyTo(turns: Turn[]): Turn[] {
    return this.plan(turns).kept;
  }

  /** Heuristic summarizer: extracts user requests + assistant decisions. */
  private summarize(turns: Turn[]): string {
    if (turns.length === 0) return '';
    const lines: string[] = [];
    for (const t of turns) {
      if (t.role === 'user') lines.push(`User asked: "${t.content.slice(0, 120)}"`);
      else if (t.role === 'assistant' && t.content.length > 40) lines.push(`Assistant noted: "${t.content.slice(0, 120)}"`);
    }
    return lines.slice(0, 8).join(' · ');
  }
}
