import { readdirSync, readFileSync, statSync, watch, FSWatcher } from 'node:fs';
import path from 'node:path';
import { tokenize } from '../utils/text.js';

export interface SkillFile {
  name: string;
  content: string;
  tokens: Set<string>;
}

/**
 * Loads markdown-formatted skill snippets from a directory. Skills whose
 * tokens overlap with the user's input are surfaced into the brain compose
 * context. Optionally watches the directory and reloads on file changes
 * (with a debounce so editors that trigger many fs events don't thrash).
 */
export class SkillsLoader {
  private skills: SkillFile[] = [];
  private watcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private readonly debounceMs: number;

  constructor(private readonly dir?: string, options: { debounceMs?: number } = {}) {
    this.debounceMs = options.debounceMs ?? 100;
    if (dir) this.reload();
  }

  reload(): void {
    if (!this.dir) {
      this.skills = [];
      return;
    }
    try {
      const stat = statSync(this.dir);
      if (!stat.isDirectory()) {
        this.skills = [];
        return;
      }
    } catch {
      this.skills = [];
      return;
    }

    const files = readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.md'));
    this.skills = files.map((file) => {
      const filePath = path.join(this.dir!, file);
      const content = readFileSync(filePath, 'utf8');
      return {
        name: file.replace(/\.md$/i, ''),
        content,
        tokens: new Set(tokenize(content))
      };
    });
  }

  watchForChanges(): void {
    if (!this.dir || this.watcher) return;
    try {
      this.watcher = watch(this.dir, { persistent: false }, () => {
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          try { this.reload(); } catch { /* ignore */ }
          this.reloadTimer = undefined;
        }, this.debounceMs);
      });
    } catch {
      // Some platforms / unmounted dirs throw; fall back silently.
    }
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
  }

  list(): SkillFile[] {
    return [...this.skills];
  }

  size(): number {
    return this.skills.length;
  }

  match(input: string, limit = 2): Array<{ name: string; content: string }> {
    if (!this.skills.length) return [];
    const queryTokens = new Set(tokenize(input));
    if (!queryTokens.size) return [];
    return this.skills
      .map((skill) => {
        let overlap = 0;
        for (const t of queryTokens) if (skill.tokens.has(t)) overlap += 1;
        return { skill, overlap };
      })
      .filter((item) => item.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, Math.max(0, limit))
      .map((item) => ({ name: item.skill.name, content: item.skill.content }));
  }
}
