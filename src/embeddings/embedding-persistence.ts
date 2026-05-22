import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EmbeddingStore, EmbeddingDoc } from './embedding-store.js';

/**
 * Atomic JSONL persistence for an EmbeddingStore. Each line is one document
 * with its vector. Designed for workspaces that need durable semantic memory
 * without taking on a real vector database.
 */
export class EmbeddingPersistence<TMeta = Record<string, unknown>> {
  constructor(private readonly filePath: string) {}

  /** Save the entire store to a JSONL file (atomic via temp + rename). */
  async save(store: EmbeddingStore<TMeta>, docs: Array<EmbeddingDoc<TMeta>>): Promise<{ written: number; bytes: number }> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const lines = docs.map((d) => JSON.stringify(d)).join('\n');
    const body = lines.length === 0 ? '' : lines + '\n';
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.filePath);
    return { written: docs.length, bytes: Buffer.byteLength(body, 'utf8') };
  }

  /** Load documents from disk (does not mutate any in-memory store). */
  async load(): Promise<Array<EmbeddingDoc<TMeta>>> {
    let body: string;
    try { body = await fs.readFile(this.filePath, 'utf8'); }
    catch { return []; }
    const docs: Array<EmbeddingDoc<TMeta>> = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { docs.push(JSON.parse(trimmed) as EmbeddingDoc<TMeta>); }
      catch { /* skip malformed line */ }
    }
    return docs;
  }

  /** Restore docs into a target store (uses the store's add() so vectors re-index correctly). */
  async restoreInto(store: EmbeddingStore<TMeta>): Promise<number> {
    const docs = await this.load();
    let restored = 0;
    for (const d of docs) {
      const addArg = d.meta !== undefined ? { id: d.id, text: d.text, meta: d.meta } : { id: d.id, text: d.text };
      await store.add(addArg);
      restored += 1;
    }
    return restored;
  }
}
