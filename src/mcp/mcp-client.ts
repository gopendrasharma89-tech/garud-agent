import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Model Context Protocol (MCP) client. Speaks JSON-RPC 2.0 over stdio to a
 * local MCP server subprocess. After `initialize()` + `listTools()`, every
 * advertised tool becomes invokable through `callTool(name, args)`.
 *
 * Zero deps \u2014 only `node:child_process` and JSON.
 *
 * Spec reference (high-level methods we implement):
 *   initialize         \u2192 handshake, returns server capabilities
 *   tools/list         \u2192 returns Tool[] with input schemas
 *   tools/call         \u2192 invokes a named tool with arguments
 *   resources/list     \u2192 optional, returns Resource[]
 *   resources/read     \u2192 optional, returns Resource body
 *   notifications/*    \u2192 server-pushed events (we currently log only)
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpClientOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** ms before a single request rejects with `mcp: timeout`. Default 30s. */
  requestTimeoutMs?: number;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class McpClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private readonly timeout: number;
  private capabilities: unknown = null;
  private startedAt = 0;

  constructor(private readonly opts: McpClientOptions) {
    this.timeout = opts.requestTimeoutMs ?? 30_000;
  }

  /** Spawn the subprocess and complete the MCP handshake. */
  async start(): Promise<{ capabilities: unknown }> {
    if (this.proc) throw new Error('mcp client already started');
    this.proc = spawn(this.opts.command, this.opts.args ?? [], {
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.startedAt = Date.now();
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
      this.pending.clear();
    });
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('mcp server exited')); }
      this.pending.clear();
    });
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'garud-agent', version: '3.8.0' }
    });
    this.capabilities = (result as { capabilities?: unknown }).capabilities ?? null;
    // Per spec, send `notifications/initialized` after initialize returns.
    this.notify('notifications/initialized', {});
    return { capabilities: this.capabilities };
  }

  /** List the server's advertised tools. */
  async listTools(): Promise<McpTool[]> {
    const r = await this.request('tools/list', {}) as { tools?: McpTool[] };
    return Array.isArray(r.tools) ? r.tools : [];
  }

  /** Invoke a server-side tool by name. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ content: unknown; isError?: boolean }> {
    const r = await this.request('tools/call', { name, arguments: args }) as { content?: unknown; isError?: boolean };
    return { content: r.content, ...(r.isError !== undefined ? { isError: r.isError } : {}) };
  }

  /** List the server's resources (optional capability). */
  async listResources(): Promise<McpResource[]> {
    try {
      const r = await this.request('resources/list', {}) as { resources?: McpResource[] };
      return Array.isArray(r.resources) ? r.resources : [];
    } catch { return []; }
  }

  /** Read a resource body. */
  async readResource(uri: string): Promise<unknown> {
    return this.request('resources/read', { uri });
  }

  /** Return uptime + capability snapshot. */
  info(): { capabilities: unknown; uptimeMs: number; running: boolean } {
    return { capabilities: this.capabilities, uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0, running: !!this.proc && !this.proc.killed };
  }

  /** Gracefully shut down. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = undefined;
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2000);
      p.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  // ────────────────────────── internals ──────────────────────────
  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp: timeout on ${method}`));
      }, this.timeout);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.proc?.stdin?.write(msg); }
      catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try { this.proc?.stdin?.write(msg); } catch { /* best-effort */ }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    // MCP framing: line-delimited JSON (LSP-style headers are not used by most servers).
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number; message: string } };
        if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`mcp error ${msg.error.code}: ${msg.error.message}`));
          else p.resolve(msg.result);
        }
        // Notifications: ignored for now.
      } catch { /* drop malformed frame */ }
    }
  }
}
