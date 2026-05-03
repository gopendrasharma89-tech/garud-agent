import { promises as fs } from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { AuditEntry, ConversationTurn, Memory, Session } from '../types.js';
import { AuditSink } from '../core/audit-log.js';
import { stableStringify } from '../utils/text.js';

interface PersistedState {
  version: number;
  sessions: Session[];
  memories: Memory[];
  conversations?: ConversationTurn[];
}

const FILE_VERSION = 3;

/**
 * File-backed persistence for sessions/memories/conversations. The state file
 * is rewritten atomically (write to .tmp then rename). Audit entries are
 * appended to a JSONL log to avoid rewrite cost. Snapshots can optionally be
 * gzip-compressed.
 */
export class JsonFileStore {
  private writing: Promise<void> = Promise.resolve();
  private lastError?: Error;

  constructor(private readonly workspaceDir: string) {}

  private statePath(): string {
    return path.join(this.workspaceDir, 'state.json');
  }

  private auditPath(): string {
    return path.join(this.workspaceDir, 'audit.log');
  }

  private snapshotPath(name: string, gzip = false): string {
    return path.join(this.workspaceDir, 'snapshots', `${name}.json${gzip ? '.gz' : ''}`);
  }

  async ensureWorkspace(): Promise<void> {
    await fs.mkdir(this.workspaceDir, { recursive: true });
    await fs.mkdir(path.join(this.workspaceDir, 'snapshots'), { recursive: true });
  }

  async load(): Promise<{ sessions: Session[]; memories: Memory[]; conversations: ConversationTurn[] }> {
    try {
      const raw = await fs.readFile(this.statePath(), 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (typeof parsed.version !== 'number') {
        return { sessions: [], memories: [], conversations: [] };
      }
      return {
        sessions: parsed.sessions ?? [],
        memories: parsed.memories ?? [],
        conversations: parsed.conversations ?? []
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { sessions: [], memories: [], conversations: [] };
      throw error;
    }
  }

  async save(snapshot: { sessions: Session[]; memories: Memory[]; conversations?: ConversationTurn[] }): Promise<void> {
    const next = this.writing
      .catch(() => undefined)
      .then(() => this.writeOnce(snapshot))
      .catch((err) => {
        this.lastError = err instanceof Error ? err : new Error(String(err));
        throw this.lastError;
      });
    this.writing = next.catch(() => undefined);
    return next;
  }

  getLastError(): Error | undefined {
    return this.lastError;
  }

  private async writeOnce(snapshot: { sessions: Session[]; memories: Memory[]; conversations?: ConversationTurn[] }): Promise<void> {
    await this.ensureWorkspace();
    const payload: PersistedState = {
      version: FILE_VERSION,
      sessions: snapshot.sessions,
      memories: snapshot.memories,
      conversations: snapshot.conversations ?? []
    };
    const target = this.statePath();
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, stableStringify(payload), 'utf8');
    await fs.rename(tmp, target);
  }

  fileSink(): AuditSink {
    const filePath = this.auditPath();
    const dir = this.workspaceDir;
    return {
      append: async (entry: AuditEntry) => {
        await fs.mkdir(dir, { recursive: true });
        await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
      }
    };
  }

  async readAudit(limit = 100): Promise<AuditEntry[]> {
    try {
      const raw = await fs.readFile(this.auditPath(), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-limit);
      const out: AuditEntry[] = [];
      for (const line of tail) {
        try { out.push(JSON.parse(line) as AuditEntry); } catch { /* skip corrupt */ }
      }
      return out;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Rotate the audit log; returns the rotated file path. */
  async rotateAudit(): Promise<string | undefined> {
    try {
      const src = this.auditPath();
      const exists = await fs.stat(src).then(() => true).catch(() => false);
      if (!exists) return undefined;
      const dest = path.join(this.workspaceDir, `audit.${Date.now()}.log`);
      await fs.rename(src, dest);
      return dest;
    } catch {
      return undefined;
    }
  }

  async writeSnapshot(
    name: string,
    snapshot: { sessions: Session[]; memories: Memory[]; conversations?: ConversationTurn[] },
    options: { gzip?: boolean } = {}
  ): Promise<string> {
    await this.ensureWorkspace();
    const filePath = this.snapshotPath(name, !!options.gzip);
    const payload: PersistedState = {
      version: FILE_VERSION,
      sessions: snapshot.sessions,
      memories: snapshot.memories,
      conversations: snapshot.conversations ?? []
    };
    const text = stableStringify(payload);
    if (options.gzip) {
      const tmp = filePath + '.tmp';
      await fs.writeFile(tmp + '.raw', text, 'utf8');
      await pipeline(createReadStream(tmp + '.raw'), createGzip(), createWriteStream(tmp));
      await fs.unlink(tmp + '.raw');
      await fs.rename(tmp, filePath);
    } else {
      await fs.writeFile(filePath, text, 'utf8');
    }
    return filePath;
  }

  async readSnapshot(name: string): Promise<{ sessions: Session[]; memories: Memory[]; conversations: ConversationTurn[] }> {
    const gzPath = this.snapshotPath(name, true);
    const plainPath = this.snapshotPath(name, false);
    const useGz = await fs.stat(gzPath).then(() => true).catch(() => false);
    let raw: string;
    if (useGz) {
      const chunks: Buffer[] = [];
      const stream = createReadStream(gzPath).pipe(createGunzip());
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
      raw = Buffer.concat(chunks).toString('utf8');
    } else {
      raw = await fs.readFile(plainPath, 'utf8');
    }
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      sessions: parsed.sessions ?? [],
      memories: parsed.memories ?? [],
      conversations: parsed.conversations ?? []
    };
  }

  async deleteSnapshot(name: string): Promise<boolean> {
    let removed = false;
    for (const candidate of [this.snapshotPath(name, false), this.snapshotPath(name, true)]) {
      try {
        await fs.unlink(candidate);
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  async listSnapshots(): Promise<string[]> {
    try {
      const dir = path.join(this.workspaceDir, 'snapshots');
      const files = await fs.readdir(dir);
      return files
        .filter((f) => f.endsWith('.json') || f.endsWith('.json.gz'))
        .map((f) => f.replace(/\.json(\.gz)?$/, ''));
    } catch {
      return [];
    }
  }
}
