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

  /** Summary stats: count of dates, bytes used, and latest date (if any). */
  async summary(): Promise<{ dates: number; bytes: number; latest?: string }> {
    try {
      const dates = await this.listDates();
      let bytes = 0;
      for (const d of dates) {
        try {
          const stat = await fs.stat(path.join(this.dir, `${d}.md`));
          bytes += stat.size;
        } catch { /* skip missing */ }
      }
      return dates.length > 0
        ? { dates: dates.length, bytes, latest: dates[0] }
        : { dates: 0, bytes: 0 };
    } catch {
      return { dates: 0, bytes: 0 };
    }
  }

  /** Read the last N daily logs combined (newest first), separated by date headers. */
  async latest(n: number): Promise<string> {
    const dates = (await this.listDates()).slice(0, Math.max(1, Math.min(365, n)));
    const parts: string[] = [];
    for (const date of dates) {
      const body = await this.read(date);
      if (body) parts.push(`# ${date}\n${body}`);
    }
    return parts.join('\n');
  }
}
