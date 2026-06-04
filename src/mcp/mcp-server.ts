import type { ToolRegistry } from '../core/tool-registry.js';
import type { ToolDefinition, ToolContext, Session } from '../types.js';
import { GARUD_VERSION } from '../version.js';

/**
 * MCP server over stdio. Run with `garud mcp` and a client like Claude Desktop
 * will discover Garud's tools as if they were its own.
 *
 * We implement the minimum methods needed to be useful:
 *   initialize, tools/list, tools/call, resources/list (empty), ping
 *
 * Tools exposed: a curated *safe* subset by default. Set
 * `GARUD_MCP_EXPOSE_ALL=1` to expose every registered tool (broader surface
 * \u2014 useful for trusted local environments only).
 */

const SAFE_PREFIXES = ['memory.', 'longterm.', 'daily.', 'skills.', 'embeddings.', 'web.fetch', 'text.', 'math.', 'time.', 'identity.', 'heartbeat.rules', 'agents.list', 'agents.find'];

export interface McpServerDeps {
  tools: ToolRegistry;
  exposeAll?: boolean;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

interface JsonRpcRequest { jsonrpc: '2.0'; id?: number | string; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number | string; result?: unknown; error?: { code: number; message: string } }

export class McpServer {
  private buffer = '';
  private stopped = false;

  constructor(private readonly deps: McpServerDeps) {}

  /** Start listening on stdin/stdout. Resolves when stdin closes. */
  async listen(): Promise<void> {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.onStdin(chunk));
    await new Promise<void>((resolve) => process.stdin.once('end', () => { this.stopped = true; resolve(); }));
  }

  private onStdin(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line).catch((err) => this.deps.logger?.warn('mcp handler error', { error: (err as Error).message }));
    }
  }

  private async handleLine(line: string): Promise<void> {
    let req: JsonRpcRequest;
    try { req = JSON.parse(line); }
    catch { return; }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') return;
    // Notifications carry no id and expect no response.
    if (req.id === undefined) {
      // We accept and ignore inbound notifications.
      return;
    }
    const id = req.id;
    try {
      const result = await this.dispatch(req.method, req.params);
      this.send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: 'garud-agent', version: GARUD_VERSION }
        };
      }
      case 'ping': return {};
      case 'tools/list': {
        const all: ToolDefinition[] = this.deps.tools.list();
        const exposed = this.deps.exposeAll
          ? all
          : all.filter((t: ToolDefinition) => SAFE_PREFIXES.some((p) => t.name === p || t.name.startsWith(p)));
        return { tools: exposed.map((t: ToolDefinition) => ({ name: t.name, description: (t as { description?: string }).description ?? '', inputSchema: { type: 'object' } })) };
      }
      case 'tools/call': {
        const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!p.name || typeof p.name !== 'string') throw new Error('name required');
        const tool = this.deps.tools.get(p.name);
        if (!tool) throw new Error(`unknown tool: ${p.name}`);
        if (!this.deps.exposeAll && !SAFE_PREFIXES.some((sp) => p.name === sp || p.name!.startsWith(sp))) {
          throw new Error(`tool not exposed via MCP: ${p.name}`);
        }
        const input = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {});
        // Minimal ToolContext for MCP invocations — no policy/audit bridge yet.
        const now = Date.now();
        const session: Session = {
          id: `mcp-${now}`,
          channel: 'mcp',
          userId: 'mcp-client',
          trustLevel: 'guest',
          role: 'channel',
          agentId: 'default',
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          settings: {}
        };
        const noopLog = {
          info: () => { /* noop */ }, warn: () => { /* noop */ },
          error: () => { /* noop */ }, debug: () => { /* noop */ },
          child: () => noopLog
        } as unknown as ToolContext['log'];
        const ctx: ToolContext = {
          session,
          requestText: input,
          now: Date.now(),
          log: noopLog,
          signal: new AbortController().signal,
          requestId: `mcp-${Date.now()}`
        };
        const result = await Promise.resolve(tool.execute(input, ctx));
        return { content: [{ type: 'text', text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }], ...(result.error ? { isError: true } : {}) };
      }
      case 'resources/list': return { resources: [] };
      default: throw new Error(`method not implemented: ${method}`);
    }
  }

  private send(msg: JsonRpcResponse): void {
    if (this.stopped) return;
    try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch { /* pipe closed */ }
  }
}
