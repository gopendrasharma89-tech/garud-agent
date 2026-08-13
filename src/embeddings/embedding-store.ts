import { tokenize } from '../utils/text.js';

/**
 * Zero-dependency semantic search via TF-IDF + cosine similarity.
 *
 * For pure local-first deployments we cannot assume a vector database or an
 * embeddings API, so the default path scores documents with TF-IDF. Weights
 * are computed *at query time* from live document frequencies and compared
 * sparsely per-term — never via dense vectors frozen at add time. (Dense
 * add-time vectors are subtly wrong: as the vocabulary grows, dimension `i`
 * stops meaning the same term across documents, so cosine compares apples
 * to oranges. That bug shipped in v3.3 and was fixed in v4.7.)
 *
 * For LLM-backed deployments, plug a real embedding model in via
 * `setVectorizer` — documents added while a vectorizer is active store its
 * dense vector, and search uses dense cosine over those.
 */

export interface EmbeddingDoc<TMeta = Record<string, unknown>> {
  id: string;
  text: string;
  /** Dense vector — only present when a custom vectorizer produced it. */
  vector?: number[];
  meta?: TMeta;
  createdAt: number;
}

export type Vectorizer = (text: string) => number[] | Promise<number[]>;

export interface EmbeddingSearchOptions<TMeta = Record<string, unknown>> {
  /** Only score documents whose metadata passes this predicate. */
  filter?: (meta: TMeta | undefined) => boolean;
}

export class EmbeddingStore<TMeta = Record<string, unknown>> {
  private readonly docs = new Map<string, EmbeddingDoc<TMeta>>();
  /** Per-doc normalised term frequencies (TF-IDF path only). */
  private readonly termFreq = new Map<string, Map<string, number>>();
  private readonly vocabulary = new Map<string, number>(); // token -> doc frequency
  private vectorizer: Vectorizer | undefined;

  /** Plug in a custom vectorizer (e.g. an LLM embeddings API). */
  setVectorizer(v: Vectorizer | undefined): void { this.vectorizer = v; }

  size(): number { return this.docs.size; }

  /** Return all stored documents (snapshot). */
  all(): Array<EmbeddingDoc<TMeta>> { return Array.from(this.docs.values()); }

  async add(doc: { id: string; text: string; meta?: TMeta }): Promise<EmbeddingDoc<TMeta>> {
    // Replacing an existing doc must first retire its vocabulary counts.
    if (this.docs.has(doc.id)) this.retire(doc.id);
    const record: EmbeddingDoc<TMeta> = {
      id: doc.id,
      text: doc.text,
      ...(doc.meta !== undefined ? { meta: doc.meta } : {}),
      createdAt: Date.now()
    };
    if (this.vectorizer) {
      record.vector = await this.vectorizer(doc.text);
    } else {
      const tokens = tokenize(doc.text);
      const freq = new Map<string, number>();
      for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
      if (tokens.length > 0) {
        for (const [t, n] of freq) freq.set(t, n / tokens.length);
      }
      this.termFreq.set(doc.id, freq);
      for (const t of freq.keys()) {
        this.vocabulary.set(t, (this.vocabulary.get(t) ?? 0) + 1);
      }
    }
    this.docs.set(doc.id, record);
    return record;
  }

  remove(id: string): boolean {
    this.retire(id);
    return this.docs.delete(id);
  }

  /** Top-K semantic search. */
  async search(
    query: string,
    k = 5,
    options: EmbeddingSearchOptions<TMeta> = {}
  ): Promise<Array<{ doc: EmbeddingDoc<TMeta>; score: number }>> {
    if (this.docs.size === 0) return [];
    const out: Array<{ doc: EmbeddingDoc<TMeta>; score: number }> = [];
    if (this.vectorizer) {
      const q = await this.vectorizer(query);
      for (const doc of this.docs.values()) {
        if (!doc.vector) continue;
        if (options.filter && !options.filter(doc.meta)) continue;
        const score = cosineDense(q, doc.vector);
        if (score > 0) out.push({ doc, score });
      }
    } else {
      const qWeights = this.weigh(normalisedFreq(tokenize(query)));
      if (qWeights.size > 0) {
        for (const doc of this.docs.values()) {
          const tf = this.termFreq.get(doc.id);
          if (!tf) continue; // added under a custom vectorizer
          if (options.filter && !options.filter(doc.meta)) continue;
          const score = cosineSparse(qWeights, this.weigh(tf));
          if (score > 0) out.push({ doc, score });
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, Math.max(1, k));
  }

  /** Clear all stored embeddings. */
  clear(): void {
    this.docs.clear();
    this.termFreq.clear();
    this.vocabulary.clear();
  }

  /** Remove a doc's contribution to vocabulary document frequencies. */
  private retire(id: string): void {
    const freq = this.termFreq.get(id);
    if (!freq) return;
    for (const t of freq.keys()) {
      const df = this.vocabulary.get(t);
      if (df === undefined) continue;
      if (df <= 1) this.vocabulary.delete(t);
      else this.vocabulary.set(t, df - 1);
    }
    this.termFreq.delete(id);
  }

  /** TF → TF-IDF using live document frequencies; unknown terms drop out. */
  private weigh(tf: Map<string, number>): Map<string, number> {
    const totalDocs = Math.max(1, this.docs.size);
    const weights = new Map<string, number>();
    for (const [term, f] of tf) {
      const df = this.vocabulary.get(term);
      if (df === undefined) continue;
      const idf = Math.log(totalDocs / df) + 1;
      weights.set(term, f * idf);
    }
    return weights;
  }
}

function normalisedFreq(tokens: string[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
  if (tokens.length > 0) {
    for (const [t, n] of freq) freq.set(t, n / tokens.length);
  }
  return freq;
}

function cosineSparse(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, v] of small) {
    const w = large.get(t);
    if (w !== undefined) dot += v * w;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function cosineDense(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
