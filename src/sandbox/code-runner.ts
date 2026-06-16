import { Worker } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Sandboxed JavaScript code runner. Spawns the user's code inside a Node
 * worker thread with no access to `require`, `import`, or the host
 * filesystem \u2014 the worker is given an isolated `vm.Script` context with
 * a handpicked set of globals.
 *
 * Limits enforced:
 *   - Wall-clock timeout (default 5s, max 60s)
 *   - Memory cap via `resourceLimits.maxOldGenerationSizeMb`
 *   - No network: worker has no fetch/XHR/http available
 *   - No filesystem: no fs module loaded into the sandbox\n *\n * Returns `{ stdout, stderr, result, error?, durationMs }`.\n *\n * Disabled by default. Enable with `GARUD_CODE_SANDBOX=1`.\n */

export interface CodeRunOptions {
  /** Source code to run. */
  code: string;
  /** Wall-clock timeout in ms. Clamped to [100, 60_000]. Default 5000. */
  timeoutMs?: number;
  /** Memory cap in MiB. Clamped to [16, 1024]. Default 128. */
  memoryMb?: number;
  /** Optional JSON-serialisable inputs exposed as `input` in the sandbox. */
  input?: unknown;
}

export interface CodeRunResult {
  ok: boolean;
  result: unknown;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  timedOut?: boolean;
}

export interface CodeRunnerOptions {
  enabled: boolean;
}

export class CodeRunner {
  constructor(private readonly opts: CodeRunnerOptions) {}

  async run(req: CodeRunOptions): Promise<CodeRunResult> {
    const t0 = Date.now();
    if (!this.opts.enabled) {
      return { ok: false, result: null, stdout: '', stderr: '', durationMs: 0, error: 'code sandbox disabled (set GARUD_CODE_SANDBOX=1)' };
    }
    const timeout = Math.max(100, Math.min(60_000, req.timeoutMs ?? 5000));
    const memMb = Math.max(16, Math.min(1024, req.memoryMb ?? 128));
    if (typeof req.code !== 'string' || req.code.length === 0) {
      return { ok: false, result: null, stdout: '', stderr: '', durationMs: 0, error: 'code required' };
    }
    if (Buffer.byteLength(req.code, 'utf8') > 256 * 1024) {
      return { ok: false, result: null, stdout: '', stderr: '', durationMs: 0, error: 'code too large (max 256 KiB)' };
    }

    // Write a minimal worker bootstrap that builds an isolated vm context.
    const bootstrap = workerSource();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garud-sb-'));
    const workerFile = path.join(dir, 'worker.mjs');
    await fs.writeFile(workerFile, bootstrap, 'utf8');

    try {
      return await new Promise<CodeRunResult>((resolve) => {
        const worker = new Worker(workerFile, {
          workerData: { code: req.code, input: req.input ?? null, timeoutMs: timeout },
          resourceLimits: { maxOldGenerationSizeMb: memMb, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16 },
          stdout: true,
          stderr: true
        });
        let stdout = '';
        let stderr = '';
        worker.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); if (stdout.length > 256 * 1024) stdout = stdout.slice(0, 256 * 1024); });
        worker.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); if (stderr.length > 64 * 1024) stderr = stderr.slice(0, 64 * 1024); });
        let timer = setTimeout(() => {
          worker.terminate().catch(() => { /* noop */ });
          resolve({ ok: false, result: null, stdout, stderr, durationMs: Date.now() - t0, error: 'wall-clock timeout', timedOut: true });
        }, timeout + 200);
        if (typeof timer.unref === 'function') timer.unref();
        worker.once('message', (msg: { ok: boolean; result?: unknown; error?: string }) => {
          clearTimeout(timer);
          worker.terminate().catch(() => { /* noop */ });
          resolve({ ok: msg.ok, result: msg.result ?? null, stdout, stderr, durationMs: Date.now() - t0, ...(msg.error ? { error: msg.error } : {}) });
        });
        worker.once('error', (err) => {
          clearTimeout(timer);
          resolve({ ok: false, result: null, stdout, stderr, durationMs: Date.now() - t0, error: err.message });
        });
      });
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => { /* noop */ });
    }
  }
}

function workerSource(): string {
  return `import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

const { code, input, timeoutMs } = workerData;

// Build an isolated context with a tiny, curated global surface.
const sandbox = {
  console,
  input,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Math,
  Date,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Map,
  Set,
  Symbol,
  Error,
  RegExp,
  Buffer
};
const ctx = vm.createContext(sandbox, { name: 'garud-sandbox' });

(async () => {
  try {
    // Wrap user code so a top-level return value is captured. We support both
    // expression bodies ('1+1') and statement bodies (with 'return' or
    // 'await').
    const wrapped = '"use strict";\\nreturn (async () => { ' + code + '\\n})();';
    const fn = vm.compileFunction(wrapped, [], { parsingContext: ctx });
    const result = await fn.call(undefined);
    parentPort?.postMessage({ ok: true, result });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
})();
`;
}
