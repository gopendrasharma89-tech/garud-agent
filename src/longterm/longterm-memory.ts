import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * File-based long-term memory store (OpenClaw-inspired MEMORY.md).
 * Persistent facts written as a markdown file. The agent reads this on
 * every turn so it always has access to durable knowledge across sessions.
 */
export class LongTermMemory {
  private cache: string | undefined;
  private dirty = false;

  constructor(private readonly filePath: string) {}

  /** Read the full MEMORY.md content (cached). */
  async read(): Promise<string> {
    if (this.cache !== undefined) return this.cache;
    try {
      this.cache = await fs.readFile(this.filePath, 'utf8');
    } catch {
      this.cache = '';
    }
    return this.cache;
  }

  /** Append a new fact under a section header. Returns the appended block. */
  async append(section: string, fact: string): Promise<string> {
    const current = await this.read();
    const stamp = new Date().toISOString().slice(0, 10);
    const block = `\n## ${section}\n- ${stamp}: ${fact.trim()}\n`;
    this.cache = current + block;
    this.dirty = true;
    await this.flush();
    return block;
  }

  /** Replace the entire memory file with a new body. */
  async replace(body: string): Promise<void> {
    this.cache = body;
    this.dirty = true;
    await this.flush();
  }

  /** Persist any pending writes to disk atomically. */
  async flush(): Promise<void> {
    if (!this.dirty || this.cache === undefined) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, this.cache, 'utf8');
    await fs.rename(tmp, this.filePath);
    this.dirty = false;
  }

  /** Search facts by substring. Returns matching lines with their section. */
  async search(query: string, limit = 10): Promise<Array<{ section: string; line: string }>> {
    const body = await this.read();
    if (!body) return [];
    const q = query.toLowerCase();
    const out: Array<{ section: string; line: string }> = [];
    let section = 'general';
    for (const raw of body.split('\n')) {
      if (raw.startsWith('## ')) { section = raw.slice(3).trim(); continue; }
      if (raw.toLowerCase().includes(q)) {
        out.push({ section, line: raw.replace(/^- /, '').trim() });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  size(): number { return this.cache?.length ?? 0; }
}
