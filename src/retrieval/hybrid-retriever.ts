import type { BM25Index } from './bm25-index.js';
import type { EmbeddingStore } from '../embeddings/embedding-store.js';

/**
 * Hybrid retriever combining BM25 (keyword) + vector (TF-IDF cosine) via
 * Reciprocal Rank Fusion. RRF is the standard fusion strategy in the
 * literature (Cormack et al.) because it requires no per-system score
 * normalisation \u2014 it only cares about *rank*.
 *
 *   rrf(d) = sum over systems S of  1 / (k + rank_S(d))
 *
 * with k = 60 by convention. The score is bounded in (0, 2/k] across both
 * systems, which keeps the magnitudes consistent across query/corpus sizes.
 */

export interface HybridSearchResult {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
  /** Fused RRF score (higher = more relevant). */
  score: number;
  /** Per-system rank breakdown for explainability. */
  ranks: { bm25?: number; vector?: number };
}

export interface HybridOptions {
  /** RRF k constant. Default 60 (literature standard). */
  k?: number;
  /** Multiplier on BM25 contribution. Default 1. Set 0 to disable. */
  bm25Weight?: number;
  /** Multiplier on vector contribution. Default 1. Set 0 to disable. */
  vectorWeight?: number;
  /** Per-system top-K to consider before fusion. Default 20. */
  perSystemK?: number;
}

export class HybridRetriever {
  constructor(
    private readonly bm25: BM25Index,
    private readonly vectors: EmbeddingStore
  ) {}

  /** Add a document to both indices in lockstep. */
  async add(doc: { id: string; text: string; meta?: Record<string, unknown> }): Promise<void> {
    this.bm25.add(doc);
    await this.vectors.add({ id: doc.id, text: doc.text, meta: doc.meta as Record<string, unknown> });
  }

  /** Remove from both. */
  remove(id: string): { bm25: boolean; vectors: boolean } {
    return { bm25: this.bm25.remove(id), vectors: this.vectors.remove(id) };
  }

  /** Total docs (BM25 view; should equal vectors). */
  size(): number { return this.bm25.size(); }

  async search(query: string, finalK = 5, opts: HybridOptions = {}): Promise<HybridSearchResult[]> {
    const k = opts.k ?? 60;
    const wB = opts.bm25Weight ?? 1;
    const wV = opts.vectorWeight ?? 1;
    const perK = Math.max(finalK, opts.perSystemK ?? 20);

    const bm25Results = wB > 0 ? this.bm25.search(query, perK) : [];
    const vecResults = wV > 0 ? await this.vectors.search(query, perK) : [];

    // Build a fused score map keyed by doc id.
    const fused = new Map<string, HybridSearchResult>();

    bm25Results.forEach((r, idx) => {
      const rank = idx + 1;
      const contribution = wB / (k + rank);
      const id = r.doc.id;
      const existing = fused.get(id);
      if (existing) {
        existing.score += contribution;
        existing.ranks.bm25 = rank;
      } else {
        const result: HybridSearchResult = {
          id,
          text: r.doc.text,
          score: contribution,
          ranks: { bm25: rank }
        };
        if (r.doc.meta !== undefined) result.meta = r.doc.meta as Record<string, unknown>;
        fused.set(id, result);
      }
    });

    vecResults.forEach((r, idx) => {
      const rank = idx + 1;
      const contribution = wV / (k + rank);
      const id = r.doc.id;
      const existing = fused.get(id);
      if (existing) {
        existing.score += contribution;
        existing.ranks.vector = rank;
      } else {
        const result: HybridSearchResult = {
          id,
          text: r.doc.text,
          score: contribution,
          ranks: { vector: rank }
        };
        if (r.doc.meta !== undefined) result.meta = r.doc.meta as Record<string, unknown>;
        fused.set(id, result);
      }
    });

    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, finalK));
  }
}
