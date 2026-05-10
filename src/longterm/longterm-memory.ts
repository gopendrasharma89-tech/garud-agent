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

  /** Append a new fact under a section header. Returns the appended fact line. */
  async append(section: string, fact: string): Promise<string> {
    const current = await this.read();
    const stamp = new Date().toISOString().slice(0, 10);
    const cleanFact = fact.trim();
    const factLine = `- ${stamp}: ${cleanFact}`;
    // If section already exists, append fact under it; else create new section.
    const sectionHeader = `## ${section}`;
    const headerIdx = current.indexOf(sectionHeader);
    if (headerIdx !== -1) {
      // Find next section or EOF and insert before it.
      const after = current.indexOf('\n## ', headerIdx + sectionHeader.length);
      const insertAt = after === -1 ? current.length : after;
      this.cache = current.slice(0, insertAt) + `\n${factLine}` + current.slice(insertAt);
    } else {
      this.cache = current + (current.endsWith('\n') || current === '' ? '' : '\n') + `\n${sectionHeader}\n${factLine}\n`;
    }
    this.dirty = true;
    await this.flush();
    return factLine;
  }

  /** Read a single named section. Returns empty string if section missing. */
  async section(name: string): Promise<string> {
    const body = await this.read();
    const header = `## ${name}`;
    const idx = body.indexOf(header);
    if (idx === -1) return '';
    const after = body.indexOf('\n## ', idx + header.length);
    return body.slice(idx, after === -1 ? undefined : after).trim();
  }

  /** Erase all long-term memory. Returns the number of bytes removed. */
  async clear(): Promise<number> {
    const before = this.cache?.length ?? (await this.read()).length;
    this.cache = '';
    this.dirty = true;
    await this.flush();
    return before;
  }

  /** Count facts (lines starting with "- " under any section). */
  async factCount(): Promise<number> {
    const body = await this.read();
    let count = 0;
    for (const line of body.split('\n')) if (line.startsWith('- ')) count += 1;
    return count;
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
