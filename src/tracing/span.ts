import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Minimal OpenTelemetry-compatible span system. Each span has a trace id,
 * a span id, a parent span id, a name, start/end timestamps, attributes,
 * and events. Spans are exported via the registered exporters.
 *
 * The point is to enable distributed tracing of agent turns / tool calls
 * without taking on the OpenTelemetry SDK as a dependency. Output is
 * compatible with the OTLP-JSON shape so downstream collectors can ingest.
 */

export interface SpanEvent {
  name: string;
  ts: number;
  attributes?: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: 'unset' | 'ok' | 'error';
  statusMessage?: string;
}

export type SpanExporter = (span: Span) => void | Promise<void>;

function hexId(bytes: number): string { return randomBytes(bytes).toString('hex'); }

export class Tracer {
  private readonly active = new Map<string, Span>();
  private readonly finished: Span[] = [];
  private readonly exporters = new Set<SpanExporter>();
  private maxFinished = 5_000;

  addExporter(exp: SpanExporter): () => void {
    this.exporters.add(exp);
    return () => this.exporters.delete(exp);
  }

  /** Start a span and return its handle. Caller MUST call `end(spanId)`. */
  start(name: string, opts: { parentSpanId?: string; traceId?: string; attributes?: Record<string, unknown> } = {}): Span {
    const parent = opts.parentSpanId ? this.active.get(opts.parentSpanId) : undefined;
    const traceId = opts.traceId ?? parent?.traceId ?? hexId(16);
    const span: Span = {
      traceId,
      spanId: hexId(8),
      ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : (parent ? { parentSpanId: parent.spanId } : {})),
      name,
      startTime: Date.now(),
      attributes: opts.attributes ?? {},
      events: [],
      status: 'unset'
    };
    this.active.set(span.spanId, span);
    return span;
  }

  /** Add an event to an active span. */
  event(spanId: string, name: string, attributes?: Record<string, unknown>): void {
    const span = this.active.get(spanId);
    if (!span) return;
    const ev: SpanEvent = { name, ts: Date.now(), ...(attributes ? { attributes } : {}) };
    span.events.push(ev);
  }

  /** Set additional attributes on an active span. */
  setAttributes(spanId: string, attributes: Record<string, unknown>): void {
    const span = this.active.get(spanId);
    if (span) Object.assign(span.attributes, attributes);
  }

  setStatus(spanId: string, status: 'ok' | 'error', message?: string): void {
    const span = this.active.get(spanId);
    if (!span) return;
    span.status = status;
    if (message !== undefined) span.statusMessage = message;
  }

  /** Finalize a span. Triggers exporters. */
  end(spanId: string): void {
    const span = this.active.get(spanId);
    if (!span) return;
    span.endTime = Date.now();
    this.active.delete(spanId);
    this.finished.push(span);
    if (this.finished.length > this.maxFinished) this.finished.splice(0, this.finished.length - this.maxFinished);
    for (const exp of this.exporters) {
      try { void exp(span); } catch { /* swallow */ }
    }
  }

  /** Get spans by trace id (in order of start time). */
  trace(traceId: string): Span[] {
    return [...this.finished, ...this.active.values()]
      .filter((s) => s.traceId === traceId)
      .sort((a, b) => a.startTime - b.startTime);
  }

  /** Recent spans (newest first). Includes both finished and in-flight spans. */
  recent(limit = 100): Span[] {
    const all = [...this.finished, ...this.active.values()].sort((a, b) => b.startTime - a.startTime);
    return all.slice(0, Math.max(1, limit));
  }

  /** Wrap an async function in a span. Resolves to the function's return value. */
  async wrap<T>(name: string, fn: (span: Span) => Promise<T> | T, attributes?: Record<string, unknown>): Promise<T> {
    const span = this.start(name, attributes ? { attributes } : {});
    try {
      const value = await fn(span);
      this.setStatus(span.spanId, 'ok');
      return value;
    } catch (error) {
      this.setStatus(span.spanId, 'error', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.end(span.spanId);
    }
  }

  /** Create a new trace id (16 random bytes hex, OTLP-compatible). */
  newTraceId(): string { return hexId(16); }
  /** Create a new span id (8 random bytes hex). */
  newSpanId(): string { return hexId(8); }
  /** Generate a UUID v4 helper. */
  uuid(): string { return randomUUID(); }

  size(): number { return this.active.size; }
  finishedCount(): number { return this.finished.length; }
}
