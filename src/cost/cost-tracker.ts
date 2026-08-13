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

export interface CostBudget {
  /** Scope to one session; omit for a global budget. */
  sessionId?: string;
  maxTokensIn?: number;
  maxTokensOut?: number;
  maxToolCalls?: number;
  maxUsd?: number;
}

export interface BudgetStatus {
  budget: CostBudget;
  usage: CostSummary;
  /** Which limits are currently exceeded (e.g. ['maxUsd']). */
  exceeded: string[];
  withinBudget: boolean;
}

export class CostTracker {
  private readonly records: CostRecord[] = [];
  private priceTable: PriceTable = {};
  private readonly budgets = new Map<string, CostBudget>();

  /** Update the price table used by `summary()`. */
  setPriceTable(table: PriceTable): void { this.priceTable = { ...table }; }

  record(rec: Omit<CostRecord, 'ts'>): CostRecord {
    // Clone labels so the caller can't mutate stored records by reusing the object.
    const full: CostRecord = {
      ts: Date.now(),
      sessionId: rec.sessionId,
      requestId: rec.requestId,
      tokensIn: rec.tokensIn,
      tokensOut: rec.tokensOut,
      toolCalls: rec.toolCalls,
      labels: { ...(rec.labels ?? {}) }
    };
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

  /** Set (or replace) a budget. One global budget plus one per sessionId. */
  setBudget(budget: CostBudget): void {
    this.budgets.set(budget.sessionId ?? '', { ...budget });
  }

  /** Remove a budget. Returns true when one existed. */
  clearBudget(sessionId?: string): boolean {
    return this.budgets.delete(sessionId ?? '');
  }

  listBudgets(): CostBudget[] {
    return Array.from(this.budgets.values(), (b) => ({ ...b }));
  }

  /** Compare current usage against the configured budget (global or session). */
  budgetStatus(sessionId?: string): BudgetStatus | undefined {
    const budget = this.budgets.get(sessionId ?? '');
    if (!budget) return undefined;
    const usage = this.summary(budget.sessionId !== undefined ? { sessionId: budget.sessionId } : {});
    const exceeded: string[] = [];
    if (budget.maxTokensIn !== undefined && usage.tokensIn > budget.maxTokensIn) exceeded.push('maxTokensIn');
    if (budget.maxTokensOut !== undefined && usage.tokensOut > budget.maxTokensOut) exceeded.push('maxTokensOut');
    if (budget.maxToolCalls !== undefined && usage.toolCalls > budget.maxToolCalls) exceeded.push('maxToolCalls');
    if (budget.maxUsd !== undefined && usage.costUsd > budget.maxUsd) exceeded.push('maxUsd');
    return { budget: { ...budget }, usage, exceeded, withinBudget: exceeded.length === 0 };
  }

  clear(): void { this.records.length = 0; }
  count(): number { return this.records.length; }
}
