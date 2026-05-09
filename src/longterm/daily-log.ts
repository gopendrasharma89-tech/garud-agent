import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Append-only daily activity log (OpenClaw-inspired logs/YYYY-MM-DD.md).
 * Writes a markdown line per turn for human-readable historical browsing.
 */
export class DailyLog {
  constructor(private readonly dir: string) {}

  private fileFor(date: Date): string {
    const ymd = date.toISOString().slice(0, 10);
    return path.join(this.dir, `${ymd}.md`);
  }

  /** Append a turn entry. Each call produces one line under a timestamp header. */
  async append(role: 'user' | 'assistant' | 'tool' | 'system', text: string, meta?: Record<string, unknown>): Promise<void> {
    const now = new Date();
    const file = this.fileFor(now);
    const time = now.toISOString().slice(11, 19);
    const safe = text.replace(/\n/g, ' ').slice(0, 2000);
    const tag = meta ? ` <!-- ${JSON.stringify(meta)} -->` : '';
    const line = `- **${time}** [${role}] ${safe}${tag}\n`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(file, line, 'utf8');
  }

  /** Read raw content for a given date (YYYY-MM-DD). Returns empty string if missing. */
  async read(ymd: string): Promise<string> {
    try { return await fs.readFile(path.join(this.dir, `${ymd}.md`), 'utf8'); }
    catch { return ''; }
  }

  /** List available log dates sorted descending. */
  async listDates(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dir);
      return files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
    } catch { return []; }
  }
}
