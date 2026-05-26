import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Claude-Code-style memory router. The on-disk layout is:
 *
 *   workspace/
 *     MEMORY.md            # the always-loaded index (capped at 200 lines)
 *     memory/
 *       <topic>.md         # lazy-loaded topic files
 *
 * MEMORY.md stays small and is read on every turn. Topic files are loaded
 * on demand via `loadTopic(domain)`. This pattern keeps the live context
 * window small while preserving deep, domain-specific knowledge on disk.
 *
 * Topic names are sanitised to lower-kebab-case to keep filenames safe.
 */
export class MemoryIndex {
  /** Hard line cap for the always-loaded MEMORY.md index (matches Claude Code). */
  static readonly INDEX_LINE_CAP = 200;
  /** Per-topic body size cap. */
  static readonly TOPIC_BYTE_CAP = 256 * 1024;

  private readonly indexPath: string;
  private readonly topicDir: string;

  constructor(workspaceDir: string) {
    this.indexPath = path.join(workspaceDir, 'MEMORY.md');
    this.topicDir = path.join(workspaceDir, 'memory');
  }

  /** Read the always-loaded MEMORY.md index, truncated to INDEX_LINE_CAP. */
  async readIndex(): Promise<{ body: string; truncated: boolean; totalLines: number }> {
    let body: string;
    try { body = await fs.readFile(this.indexPath, 'utf8'); }
    catch { return { body: '', truncated: false, totalLines: 0 }; }
    const lines = body.split('\n');
    const total = lines.length;
    if (total <= MemoryIndex.INDEX_LINE_CAP) return { body, truncated: false, totalLines: total };
    return {
      body: lines.slice(0, MemoryIndex.INDEX_LINE_CAP).join('\n') + '\n',
      truncated: true,
      totalLines: total
    };
  }

  /** Overwrite the index atomically. Caller is responsible for line budgeting. */
  async writeIndex(body: string): Promise<{ bytes: number; lines: number }> {
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new Error('MEMORY.md too large (max 1 MiB)');
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    const tmp = `${this.indexPath}.tmp`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.indexPath);
    return { bytes: Buffer.byteLength(body, 'utf8'), lines: body.split('\n').length };
  }

  /** Lazy-load a single topic file by domain name. Returns null if not present. */
  async loadTopic(domain: string): Promise<string | null> {
    const safe = sanitize(domain);
    if (!safe) return null;
    try { return await fs.readFile(path.join(this.topicDir, `${safe}.md`), 'utf8'); }
    catch { return null; }
  }

  /** Save (overwrite) a single topic file atomically. */
  async saveTopic(domain: string, body: string): Promise<{ topic: string; bytes: number }> {
    const safe = sanitize(domain);
    if (!safe) throw new Error('memory topic: empty/invalid name');
    if (Buffer.byteLength(body, 'utf8') > MemoryIndex.TOPIC_BYTE_CAP) {
      throw new Error(`memory topic ${safe}: too large (max ${MemoryIndex.TOPIC_BYTE_CAP} bytes)`);
    }
    await fs.mkdir(this.topicDir, { recursive: true });
    const file = path.join(this.topicDir, `${safe}.md`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, file);
    return { topic: safe, bytes: Buffer.byteLength(body, 'utf8') };
  }

  /** List all available topic files (without extension). */
  async listTopics(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.topicDir);
      return entries.filter((e) => e.endsWith('.md')).map((e) => e.slice(0, -3)).sort();
    } catch { return []; }
  }

  /** Remove a topic file. Returns true if deleted, false if it didn't exist. */
  async removeTopic(domain: string): Promise<boolean> {
    const safe = sanitize(domain);
    if (!safe) return false;
    try { await fs.unlink(path.join(this.topicDir, `${safe}.md`)); return true; }
    catch { return false; }
  }
}

function sanitize(name: string): string {
  return (name ?? '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
