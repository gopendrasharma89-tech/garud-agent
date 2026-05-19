/**
 * Cost & usage tracker. Records per-session, per-request token usage,
 * tool invocations, and (optional) USD cost based on a price table.
 * Inspired by LangChain's callback tracker and OpenTelemetry meters.
 */

export interface CostRecord {
  sessionId: string;
  requestId: string;
  ts: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  /** Free-form labels for grouping/filtering. */
  labels: Record<string, string>;
}

export interface CostSummary {
  records: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
}

export interface PriceTable {
  /** USD per 1000 input tokens. */
  inputPer1K?: number;
  /** USD per 1000 output tokens. */
  outputPer1K?: number;
  /** USD per tool call. */
  perToolCall?: number;
}

export class CostTracker {
  private readonly records: CostRecord[] = [];
  private priceTable: PriceTable = {};

  /** Update the price table used by `summary()`. */
  setPriceTable(table: PriceTable): void { this.priceTable = { ...table }; }

  record(rec: Omit<CostRecord, 'ts'>): CostRecord {
    const full: CostRecord = { ts: Date.now(), ...rec };
    this.records.push(full);
    // Bound memory at 10k records.
    if (this.records.length > 10_000) this.records.splice(0, this.records.length - 10_000);
    return full;
  }

  /** Aggregate cost for an optional filter (session, request, label match). */
  summary(filter: { sessionId?: string; requestId?: string; labelKey?: string; labelValue?: string } = {}): CostSummary {
    let tokensIn = 0, tokensOut = 0, toolCalls = 0, records = 0;
    for (const r of this.records) {
      if (filter.sessionId && r.sessionId !== filter.sessionId) continue;
      if (filter.requestId && r.requestId !== filter.requestId) continue;
      if (filter.labelKey !== undefined) {
        if (filter.labelValue !== undefined) {
          if (r.labels[filter.labelKey] !== filter.labelValue) continue;
        } else if (!(filter.labelKey in r.labels)) continue;
      }
      records += 1;
      tokensIn += r.tokensIn;
      tokensOut += r.tokensOut;
      toolCalls += r.toolCalls;
    }
    const p = this.priceTable;
    const costUsd =
      (tokensIn / 1000) * (p.inputPer1K ?? 0) +
      (tokensOut / 1000) * (p.outputPer1K ?? 0) +
      toolCalls * (p.perToolCall ?? 0);
    return { records, tokensIn, tokensOut, toolCalls, costUsd };
  }

  list(filter: { sessionId?: string; requestId?: string; limit?: number } = {}): CostRecord[] {
    const out = this.records.filter((r) => {
      if (filter.sessionId && r.sessionId !== filter.sessionId) return false;
      if (filter.requestId && r.requestId !== filter.requestId) return false;
      return true;
    });
    return filter.limit ? out.slice(-filter.limit) : out;
  }

  clear(): void { this.records.length = 0; }
  count(): number { return this.records.length; }
}
