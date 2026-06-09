/**
 * Garud Eval Harness. Loads a JSON suite of test cases, runs each through a
 * caller-supplied `run()` function (typically the gateway brain), and scores
 * with deterministic metrics:
 *
 *   - substring match (`expect.contains`)
 *   - regex match    (`expect.regex`)
 *   - JSON field eq  (`expect.jsonField`)
 *   - tool used      (`expect.toolsUsed`)
 *
 * Latency is tracked per-case; the suite reports mean / p50 / p95 / p99.
 */

export interface EvalCase {
  id: string;
  input: string;
  channel?: string;
  userId?: string;
  expect?: {
    contains?: string | string[];
    regex?: string;
    toolsUsed?: string[];
    jsonField?: { path: string; equals: unknown };
  };
  tags?: string[];
}

export interface EvalRunOutput {
  text: string;
  toolsUsed?: string[];
}

export interface EvalCaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  durationMs: number;
  output: EvalRunOutput;
}

export interface EvalSuiteResult {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  cases: EvalCaseResult[];
}

export interface EvalHarnessOptions {
  run: (c: EvalCase) => Promise<EvalRunOutput>;
  /** Optional per-case timeout in ms. Default 30s. */
  caseTimeoutMs?: number;
}

export class EvalHarness {
  constructor(private readonly opts: EvalHarnessOptions) {}

  async runSuite(cases: EvalCase[]): Promise<EvalSuiteResult> {
    const t0 = Date.now();
    const results: EvalCaseResult[] = [];
    for (const c of cases) results.push(await this.runCase(c));
    const total = results.length;
    const passed = results.filter((r) => r.passed).length;
    const latencies = results.map((r) => r.durationMs).sort((a, b) => a - b);
    return {
      total,
      passed,
      failed: total - passed,
      passRate: total === 0 ? 0 : passed / total,
      durationMs: Date.now() - t0,
      meanLatencyMs: total === 0 ? 0 : Math.round(latencies.reduce((a, b) => a + b, 0) / total),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      p99LatencyMs: percentile(latencies, 0.99),
      cases: results
    };
  }

  private async runCase(c: EvalCase): Promise<EvalCaseResult> {
    const t0 = Date.now();
    const failures: string[] = [];
    const timeout = this.opts.caseTimeoutMs ?? 30_000;
    let output: EvalRunOutput = { text: '' };
    try {
      output = await withTimeout(this.opts.run(c), timeout);
    } catch (e) {
      failures.push(`run threw: ${(e as Error).message}`);
      return { id: c.id, passed: false, failures, durationMs: Date.now() - t0, output };
    }
    const exp = c.expect ?? {};
    const containsList = Array.isArray(exp.contains) ? exp.contains : (exp.contains ? [exp.contains] : []);
    for (const sub of containsList) {
      if (!output.text.includes(sub)) failures.push(`output missing substring: ${sub.slice(0, 80)}`);
    }
    if (exp.regex) {
      try {
        const re = new RegExp(exp.regex);
        if (!re.test(output.text)) failures.push(`output did not match regex /${exp.regex}/`);
      } catch (e) { failures.push(`invalid regex: ${(e as Error).message}`); }
    }
    if (exp.toolsUsed && exp.toolsUsed.length > 0) {
      const used = new Set(output.toolsUsed ?? []);
      for (const t of exp.toolsUsed) {
        if (!used.has(t)) failures.push(`expected tool used: ${t}`);
      }
    }
    if (exp.jsonField) {
      try {
        const parsed = JSON.parse(output.text);
        const actual = readPath(parsed, exp.jsonField.path);
        if (!deepEqual(actual, exp.jsonField.equals)) {
          failures.push(`jsonField ${exp.jsonField.path}: expected ${JSON.stringify(exp.jsonField.equals)} got ${JSON.stringify(actual)}`);
        }
      } catch (e) { failures.push(`jsonField check failed: ${(e as Error).message}`); }
    }
    return { id: c.id, passed: failures.length === 0, failures, durationMs: Date.now() - t0, output };
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

function readPath(obj: unknown, p: string): unknown {
  let cur: unknown = obj;
  for (const part of p.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao), bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`eval case timed out after ${ms}ms`)), ms);
    if (typeof t.unref === 'function') t.unref();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
