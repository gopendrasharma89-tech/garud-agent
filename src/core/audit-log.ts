import { randomUUID } from 'node:crypto';
import { AuditEntry } from '../types.js';

export interface AuditSink {
  append(entry: AuditEntry): void | Promise<void>;
}

export class InMemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  append(entry: AuditEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }

  list(filter?: { sessionId?: string; kind?: AuditEntry['kind']; requestId?: string; limit?: number }): AuditEntry[] {
    let view = this.entries;
    if (filter?.sessionId) view = view.filter((e) => e.sessionId === filter.sessionId);
    if (filter?.kind) view = view.filter((e) => e.kind === filter.kind);
    if (filter?.requestId) view = view.filter((e) => e.requestId === filter.requestId);
    if (filter?.limit) view = view.slice(-filter.limit);
    return [...view];
  }

  clear(): void {
    this.entries.length = 0;
  }

  size(): number {
    return this.entries.length;
  }
}

export class AuditLogger {
  private sinks: AuditSink[] = [];
  private inMemorySink?: InMemoryAuditLog;

  addSink(sink: AuditSink): void {
    this.sinks.push(sink);
    if (sink instanceof InMemoryAuditLog && !this.inMemorySink) {
      this.inMemorySink = sink;
    }
  }

  removeSinks(): void {
    this.sinks = [];
    this.inMemorySink = undefined;
  }

  getInMemorySink(): InMemoryAuditLog | undefined {
    return this.inMemorySink;
  }

  async record(
    kind: AuditEntry['kind'],
    detail: Record<string, unknown>,
    sessionId?: string,
    requestId?: string
  ): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: randomUUID(),
      ts: Date.now(),
      kind,
      sessionId,
      requestId,
      detail
    };
    for (const sink of this.sinks) {
      try {
        await sink.append(entry);
      } catch {
        // sinks must not block the runtime
      }
    }
    return entry;
  }
}
