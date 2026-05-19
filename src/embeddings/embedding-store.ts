import { tokenize } from '../utils/text.js';

/**
 * Zero-dependency semantic search via TF-IDF + cosine similarity.
 *
 * For pure local-first deployments we cannot assume a vector database or
 * an embeddings API. TF-IDF over tokenized documents gives a meaningful
 * "semantic-ish" search that complements the keyword search in MemoryStore.
 * For LLM-backed deployments, swap in a real embedding model via the
 * `setVectorizer` hook.
 */

export interface EmbeddingDoc<TMeta = Record<string, unknown>> {
  id: string;
  text: string;
  vector?: number[];
  meta?: TMeta;
  createdAt: number;
}

export type Vectorizer = (text: string) => number[] | Promise<number[]>;

export class EmbeddingStore<TMeta = Record<string, unknown>> {
  private readonly docs = new Map<string, EmbeddingDoc<TMeta>>();
  private vocabulary = new Map<string, number>(); // token -> doc frequency
  private vectorizer: Vectorizer | undefined;

  /** Plug in a custom vectorizer (e.g. an LLM embeddings API). */
  setVectorizer(v: Vectorizer | undefined): void { this.vectorizer = v; }

  size(): number { return this.docs.size; }

  async add(doc: { id: string; text: string; meta?: TMeta }): Promise<EmbeddingDoc<TMeta>> {
    const vector = this.vectorizer
      ? await this.vectorizer(doc.text)
      : this.tfidf(doc.text, true);
    const record: EmbeddingDoc<TMeta> = {
      id: doc.id,
      text: doc.text,
      vector,
      ...(doc.meta !== undefined ? { meta: doc.meta } : {}),
      createdAt: Date.now()
    };
    this.docs.set(doc.id, record);
    return record;
  }

  remove(id: string): boolean { return this.docs.delete(id); }

  /** Top-K semantic search. */
  async search(query: string, k = 5): Promise<Array<{ doc: EmbeddingDoc<TMeta>; score: number }>> {
    if (this.docs.size === 0) return [];
    const q = this.vectorizer ? await this.vectorizer(query) : this.tfidf(query, false);
    const out: Array<{ doc: EmbeddingDoc<TMeta>; score: number }> = [];
    for (const doc of this.docs.values()) {
      if (!doc.vector) continue;
      const score = cosine(q, doc.vector);
      if (score > 0) out.push({ doc, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, Math.max(1, k));
  }

  /** TF-IDF vectorization. `updateVocabulary` true when indexing a new doc. */
  private tfidf(text: string, updateVocabulary: boolean): number[] {
    const tokens = tokenize(text);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

    if (updateVocabulary) {
      const seen = new Set<string>();
      for (const t of tokens) {
        if (seen.has(t)) continue;
        seen.add(t);
        this.vocabulary.set(t, (this.vocabulary.get(t) ?? 0) + 1);
      }
    }

    const totalDocs = Math.max(1, this.docs.size + (updateVocabulary ? 1 : 0));
    const vec: number[] = [];
    const vocab = [...this.vocabulary.keys()].sort();
    for (const term of vocab) {
      const tf = (freq.get(term) ?? 0) / Math.max(1, tokens.length);
      const df = this.vocabulary.get(term) ?? 1;
      const idf = Math.log(totalDocs / df) + 1;
      vec.push(tf * idf);
    }
    return vec;
  }

  /** Clear all stored embeddings. */
  clear(): void {
    this.docs.clear();
    this.vocabulary.clear();
  }
}

function cosine(a: number[], b: number[]): number {
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
