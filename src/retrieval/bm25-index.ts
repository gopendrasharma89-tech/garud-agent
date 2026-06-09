/**
 * Okapi BM25 keyword index. Used alongside the TF-IDF EmbeddingStore to do
 * proper hybrid retrieval: a query hits both, the two ranked lists are
 * combined via Reciprocal Rank Fusion (see hybrid-retriever.ts).
 *
 * BM25 is the workhorse of every "real" search engine \u2014 Elasticsearch,
 * Lucene, Postgres FTS \u2014 because it handles document length and term
 * saturation gracefully. We implement it in ~80 lines of TypeScript.
 *
 * Formula (per term t in query q, per document d):
 *   idf(t)  = log( (N - df(t) + 0.5) / (df(t) + 0.5) + 1 )
 *   score(t,d) = idf(t) * (tf(t,d) * (k1+1)) / (tf(t,d) + k1 * (1 - b + b * |d|/avgdl))
 * Standard defaults: k1=1.5, b=0.75.
 */

export interface BM25Doc<TMeta = Record<string, unknown>> {
  id: string;
  text: string;
  meta?: TMeta;
  /** Per-doc term frequencies (computed on add). */
  tf: Map<string, number>;
  /** Total token count after tokenisation \u2014 used for length normalisation. */
  length: number;
}

export interface BM25SearchResult<TMeta = Record<string, unknown>> {
  doc: BM25Doc<TMeta>;
  score: number;
}

export interface BM25Options {
  k1?: number;
  b?: number;
}

export class BM25Index<TMeta = Record<string, unknown>> {
  private readonly docs = new Map<string, BM25Doc<TMeta>>();
  /** Document frequency: token -> number of docs containing it. */
  private readonly df = new Map<string, number>();
  private totalLength = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(opts: BM25Options = {}) {
    this.k1 = opts.k1 ?? 1.5;
    this.b = opts.b ?? 0.75;
  }

  add(doc: { id: string; text: string; meta?: TMeta }): BM25Doc<TMeta> {
    // Replace existing doc with same id (keep df accurate).
    if (this.docs.has(doc.id)) this.remove(doc.id);
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const stored: BM25Doc<TMeta> = {
      id: doc.id,
      text: doc.text,
      ...(doc.meta !== undefined ? { meta: doc.meta } : {}),
      tf,
      length: tokens.length
    };
    this.docs.set(doc.id, stored);
    this.totalLength += tokens.length;
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    return stored;
  }

  remove(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;
    this.docs.delete(id);
    this.totalLength -= doc.length;
    for (const t of doc.tf.keys()) {
      const count = (this.df.get(t) ?? 1) - 1;
      if (count <= 0) this.df.delete(t);
      else this.df.set(t, count);
    }
    return true;
  }

  size(): number { return this.docs.size; }

  /** All documents (snapshot). */
  all(): Array<BM25Doc<TMeta>> { return [...this.docs.values()]; }

  /** Top-K BM25 search. */
  search(query: string, k = 5): Array<BM25SearchResult<TMeta>> {
    if (this.docs.size === 0) return [];
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const N = this.docs.size;
    const avgdl = this.totalLength / Math.max(1, N);
    // Score every doc that contains at least one query term.
    const scores = new Map<string, number>();
    for (const t of qTokens) {
      const df = this.df.get(t);
      if (!df) continue;
      const idf = Math.log(((N - df + 0.5) / (df + 0.5)) + 1);
      // Walk only docs that contain this term \u2014 cheap because we iterate all
      // docs but skip those without tf entry. For very large corpora a
      // real posting list would be O(df), not O(N); for our scale this is fine.
      for (const doc of this.docs.values()) {
        const tf = doc.tf.get(t);
        if (!tf) continue;
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * doc.length / avgdl));
        scores.set(doc.id, (scores.get(doc.id) ?? 0) + idf * norm);
      }
    }
    const out: Array<BM25SearchResult<TMeta>> = [];
    for (const [id, score] of scores) {
      const doc = this.docs.get(id);
      if (doc) out.push({ doc, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, Math.max(1, Math.min(100, k)));
  }

  /** Clear the entire index. */
  clear(): void {
    this.docs.clear();
    this.df.clear();
    this.totalLength = 0;
  }
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const t of (s ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 2 && t.length <= 40) out.push(t);
  }
  return out;
}
