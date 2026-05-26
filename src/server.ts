import http from 'node:http';
import { Gateway } from './gateway.js';
import { ToolRegistry } from './core/tool-registry.js';
import { MetricsRegistry } from './metrics/registry.js';
import { renderDashboard } from './middleware/dashboard.js';
import { verifySignature } from './webhook/signature.js';
import { AppConfig, AuditEntry, IncomingMessage, Logger, TrustLevel } from './types.js';
import { noopLogger } from './utils/logger.js';
import { newRequestId } from './utils/request-id.js';
import { GARUD_BUILD, GARUD_VERSION } from './version.js';

const VALID_AUDIT_KINDS = new Set<AuditEntry['kind']>([
  'message', 'reply', 'tool', 'policy', 'error', 'system', 'pairing', 'cron', 'quota'
]);

export interface ServerDeps {
  gateway: Gateway;
  config: AppConfig;
  tools: ToolRegistry;
  metrics?: MetricsRegistry;
  logger?: Logger;
  wsClientCount?: () => number;
  longterm?: import('./longterm/longterm-memory.js').LongTermMemory;
  dailyLog?: import('./longterm/daily-log.js').DailyLog;
  subagent?: import('./subagent/subagent-runner.js').SubAgentRunner;
  nodes?: import('./nodes/node-registry.js').NodeRegistry;
  hooks?: import('./hooks/hook-runner.js').HookRunner;
  workspace?: import('./workspace/workspace-files.js').WorkspaceFiles;
  heartbeat?: import('./heartbeat/heartbeat.js').Heartbeat;
  embeddings?: import('./embeddings/embedding-store.js').EmbeddingStore;
  costTracker?: import('./cost/cost-tracker.js').CostTracker;
  tracer?: import('./tracing/span.js').Tracer;
  /**
   * Per-channel HMAC secrets. When set, the matching `/channel/*` endpoint
   * requires a matching `x-hub-signature-256` (or `x-garud-signature`) header.
   * When unset, the endpoint accepts unsigned payloads (backwards-compatible).
   */
  channelSecrets?: {
    whatsapp?: string;
    telegram?: string;
    /** Discord uses Ed25519. Provide the application's public key in hex. */
    discord?: string;
    /** Slack uses the v0 scheme (`v0:ts:body`). Provide the signing secret. */
    slack?: string;
  };
  memoryIndex?: import('./memory/memory-index.js').MemoryIndex;
  skills?: import('./skills/skill-library.js').SkillLibrary;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const DEFAULT_MAX_BODY = 65_536;

interface ReadJsonResult<T> {
  payload: T;
  raw: Buffer;
}

function readBody(req: http.IncomingMessage, maxBytes = DEFAULT_MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson<T>(req: http.IncomingMessage, maxBytes = DEFAULT_MAX_BODY): Promise<ReadJsonResult<T>> {
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) return { payload: {} as T, raw };
  try {
    return { payload: JSON.parse(raw.toString('utf8')) as T, raw };
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return undefined;
}

function isAuthorized(req: http.IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  return bearerToken(req) === expectedToken;
}

/** Returns 'write' if authorized for mutations, 'read' if read-only, undefined if unauthorized. */
function authorize(req: http.IncomingMessage, config: AppConfig): 'write' | 'read' | undefined {
  if (!config.authToken && !config.readToken) return 'write';
  const token = bearerToken(req);
  if (config.authToken && token === config.authToken) return 'write';
  if (config.readToken && token === config.readToken) return 'read';
  if (!config.authToken && !token) return 'write'; // open mode
  return undefined;
}

function applyCorsHeaders(res: http.ServerResponse, origin: string | undefined, config: AppConfig): void {
  if (!config.cors.enabled) return;
  const allowed = config.cors.origins;
  if (allowed.includes('*')) {
    res.setHeader('access-control-allow-origin', '*');
  } else if (origin && allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-request-id, x-garud-signature');
  res.setHeader('access-control-max-age', '600');
}

export function createServer(deps: ServerDeps): http.Server {
  const { gateway, config, tools, metrics } = deps;
  const log = deps.logger ?? noopLogger;

  const server = http.createServer(async (req, res) => {
    const requestId = (req.headers['x-request-id'] as string | undefined) ?? newRequestId();
    res.setHeader('x-request-id', requestId);
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    const origin = req.headers.origin as string | undefined;
    applyCorsHeaders(res, origin, config);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    log.debug('request', { method: req.method, path: url.pathname, requestId });

    try {
      // ───────────────────────── public endpoints ──────────────────────────
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          agent: config.agent.name,
          brain: gateway.getRuntime().getBrainName(),
          ts: Date.now(),
          version: GARUD_VERSION
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/version') {
        return send(res, 200, {
          ok: true,
          ...GARUD_BUILD,
          node: process.version,
          uptime: Math.floor(process.uptime())
        });
      }

      if (req.method === 'GET' && url.pathname === '/ready') {
        const stats = gateway.getStats();
        const reasons: string[] = [];
        if (stats.errors >= 100) reasons.push('error-rate');
        const brainName = gateway.getRuntime().getBrainName();
        if (!brainName) reasons.push('brain-unavailable');
        if (stats.handled > 0 && stats.errors / Math.max(1, stats.handled) > 0.5) {
          reasons.push('error-ratio-exceeded');
        }
        const ready = reasons.length === 0;
        return send(res, ready ? 200 : 503, {
          ok: ready,
          reasons,
          stats: { errors: stats.errors, sessions: stats.sessions, memories: stats.memories },
          version: GARUD_VERSION
        });
      }

      if (req.method === 'GET' && url.pathname === '/live') {
        return send(res, 200, { ok: true, ts: Date.now(), version: GARUD_VERSION });
      }

      if (req.method === 'GET' && url.pathname === '/slo') {
        const stats = gateway.getStats();
        const errorRate = stats.handled > 0 ? stats.errors / stats.handled : 0;
        const target = 0.01; // 1% error budget
        return send(res, 200, {
          ok: true,
          slo: {
            errorRate,
            target,
            withinBudget: errorRate <= target,
            handled: stats.handled,
            errors: stats.errors,
            budgetRemaining: Math.max(0, target * Math.max(1, stats.handled) - stats.errors)
          }
        });
      }

      if (req.method === 'GET' && url.pathname === '/' && config.dashboard.enabled) {
        const stats = gateway.getStats();
        const html = renderDashboard({
          agent: config.agent.name,
          brain: gateway.getRuntime().getBrainName(),
          version: GARUD_VERSION,
          handled: stats.handled,
          rateLimited: stats.rateLimited,
          duplicates: stats.duplicates,
          errors: stats.errors,
          sessions: stats.sessions,
          memories: stats.memories,
          channels: [...gateway.channels.keys()],
          tools: tools.size(),
          cache: stats.cache,
          ws: deps.wsClientCount?.(),
          conversations: stats.conversations
        });
        return sendText(res, 200, 'text/html; charset=utf-8', html);
      }

      if (req.method === 'GET' && url.pathname === '/metrics' && config.metrics.enabled && metrics) {
        gateway.refreshGauges();
        return sendText(res, 200, 'text/plain; version=0.0.4', metrics.render());
      }

      // ───────────────────── inbound webhook channel ──────────────────────
      if (req.method === 'POST'
          && config.webhook.enabled
          && url.pathname.startsWith(config.webhook.pathPrefix + '/')) {
        const channel = url.pathname.slice(config.webhook.pathPrefix.length + 1);
        if (!channel) return send(res, 400, { ok: false, error: 'channel required' });
        if (!gateway.channels.has(channel)) {
          return send(res, 404, { ok: false, error: `channel not registered: ${channel}` });
        }

        let raw: Buffer;
        try { raw = await readBody(req); }
        catch { return send(res, 413, { ok: false, error: 'payload too large or unreadable' }); }

        // Webhook auth: prefer signature (constant-time HMAC), then bearer.
        if (config.webhook.signingSecret) {
          const sigHeader = req.headers['x-garud-signature'];
          const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
          if (!sig || !verifySignature(config.webhook.signingSecret, raw, sig)) {
            return send(res, 401, { ok: false, error: 'invalid signature' });
          }
        } else if (!isAuthorized(req, config.authToken)) {
          return send(res, 401, { ok: false, error: 'unauthorized' });
        }

        let payload: Partial<IncomingMessage>;
        try {
          payload = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
        } catch {
          return send(res, 400, { ok: false, error: 'invalid JSON' });
        }
        if (!payload.userId || !payload.text) {
          return send(res, 400, { ok: false, error: 'userId, text required' });
        }
        try {
          const detail = await gateway.handleDetailed({
            channel,
            userId: payload.userId,
            text: payload.text,
            trustLevel: payload.trustLevel,
            agentId: payload.agentId,
            clientId: payload.clientId,
            requestId
          });
          return send(res, detail.rateLimited ? 429 : 200, {
            ok: !detail.rateLimited,
            requestId: detail.requestId,
            reply: detail.reply
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return send(res, 400, { ok: false, error: msg });
        }
      }

      // ───────────────────────── auth-protected ─────────────────────────
      const scope = authorize(req, config);
      if (!scope) {
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }
      const isReadOnly = scope === 'read';

      // Read endpoints (allowed for both scopes).
      if (req.method === 'GET' && url.pathname === '/sessions') {
        return send(res, 200, gateway.sessions.list());
      }

      const sessHistoryMatch = req.method === 'GET' && /^\/sessions\/[^/]+\/history$/.test(url.pathname);
      if (sessHistoryMatch) {
        const sid = url.pathname.split('/')[2]!;
        const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10)));
        const turns = gateway.conversation?.list(sid, limit) ?? [];
        return send(res, 200, { ok: true, sessionId: sid, turns });
      }

      if (req.method === 'GET' && url.pathname === '/tools') {
        return send(res, 200, {
          ok: true,
          tools: tools.list().map((t) => ({
            name: t.name,
            description: t.description,
            tags: t.tags ?? [],
            inputHint: t.inputHint,
            aliases: t.aliases ?? [],
            cacheable: !!t.cacheable,
            dailyQuota: t.dailyQuota
          }))
        });
      }

      if (req.method === 'GET' && url.pathname === '/stats') {
        return send(res, 200, {
          ok: true,
          stats: gateway.getStats(),
          channels: [...gateway.channels.keys()],
          ws: deps.wsClientCount?.()
        });
      }

      if (req.method === 'GET' && url.pathname === '/audit') {
        const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') ?? '50', 10)));
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const requestIdFilter = url.searchParams.get('requestId') ?? undefined;
        const kindParam = url.searchParams.get('kind') ?? undefined;
        const kind = kindParam && VALID_AUDIT_KINDS.has(kindParam as AuditEntry['kind'])
          ? (kindParam as AuditEntry['kind'])
          : undefined;
        const sink = gateway.audit?.getInMemorySink();
        const entries = sink?.list({ sessionId, requestId: requestIdFilter, kind, limit }) ?? [];
        return send(res, 200, { ok: true, entries });
      }

      if (req.method === 'GET' && url.pathname === '/audit/export') {
        const sink = gateway.audit?.getInMemorySink();
        const entries = sink?.list({ limit: 10_000 }) ?? [];
        const ndjson = entries.map((e) => JSON.stringify(e)).join('\n');
        return sendText(res, 200, 'application/x-ndjson; charset=utf-8', ndjson);
      }

      // ===== v2.2: OpenClaw subsystem endpoints =====
      if (req.method === 'GET' && url.pathname === '/longterm') {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        return send(res, 200, {
          ok: true,
          bytes: deps.longterm.size(),
          body: await deps.longterm.read(),
          facts: await deps.longterm.factCount(),
          sections: await deps.longterm.sections()
        });
      }

      if (req.method === 'GET' && url.pathname === '/longterm/stats') {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        return send(res, 200, {
          ok: true,
          bytes: deps.longterm.size(),
          facts: await deps.longterm.factCount(),
          sections: (await deps.longterm.sections()).length
        });
      }

      const sectionMatch = req.method === 'GET' && /^\/longterm\/section\/[^/]+$/.test(url.pathname);
      if (sectionMatch) {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        const name = decodeURIComponent(url.pathname.split('/')[3]!);
        const body = await deps.longterm.section(name);
        return send(res, 200, { ok: true, section: name, body });
      }

      if (req.method === 'GET' && url.pathname === '/sub-agents') {
        if (!deps.subagent) return send(res, 503, { ok: false, error: 'subagent not configured' });
        const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10)));
        return send(res, 200, { ok: true, jobs: deps.subagent.list(limit), stats: deps.subagent.stats() });
      }

      const subAgentGetMatch = req.method === 'GET' && /^\/sub-agents\/[^/]+$/.test(url.pathname);
      if (subAgentGetMatch) {
        if (!deps.subagent) return send(res, 503, { ok: false, error: 'subagent not configured' });
        const id = url.pathname.split('/')[2]!;
        const job = deps.subagent.get(id);
        return job ? send(res, 200, { ok: true, job }) : send(res, 404, { ok: false, error: 'job not found' });
      }

      if (req.method === 'GET' && url.pathname === '/nodes') {
        if (!deps.nodes) return send(res, 503, { ok: false, error: 'nodes not configured' });
        return send(res, 200, { ok: true, nodes: deps.nodes.list(), stats: deps.nodes.stats() });
      }

      if (req.method === 'GET' && url.pathname === '/nodes/invocations') {
        if (!deps.nodes) return send(res, 503, { ok: false, error: 'nodes not configured' });
        const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') ?? '50', 10)));
        return send(res, 200, { ok: true, invocations: deps.nodes.listInvocations().slice(0, limit) });
      }

      if (req.method === 'GET' && url.pathname === '/hooks') {
        if (!deps.hooks) return send(res, 503, { ok: false, error: 'hooks not configured' });
        return send(res, 200, { ok: true, hooks: deps.hooks.list(), size: deps.hooks.size() });
      }

      // ===== v2.3: write endpoints for OpenClaw subsystems =====
      if (req.method === 'POST' && url.pathname === '/longterm/append') {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        let payload: { section?: string; fact?: string };
        try { payload = (await readJson<{ section?: string; fact?: string }>(req)).payload; }
        catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (!payload.section || !payload.fact) {
          return send(res, 400, { ok: false, error: 'section, fact required' });
        }
        const line = await deps.longterm.append(payload.section, payload.fact);
        return send(res, 200, { ok: true, line });
      }

      if (req.method === 'DELETE' && url.pathname === '/longterm') {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        const bytes = await deps.longterm.clear();
        return send(res, 200, { ok: true, bytesRemoved: bytes });
      }

      if (req.method === 'GET' && url.pathname === '/longterm/history') {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit') ?? '50', 10)));
        return send(res, 200, { ok: true, history: await deps.longterm.history(limit) });
      }

      const byDateMatch = req.method === 'GET' && /^\/longterm\/by-date\/\d{4}-\d{2}-\d{2}$/.test(url.pathname);
      if (byDateMatch) {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        const date = url.pathname.split('/')[3]!;
        return send(res, 200, { ok: true, date, facts: await deps.longterm.byDate(date) });
      }

      if (req.method === 'GET' && url.pathname === '/daily') {
        if (!deps.dailyLog) return send(res, 503, { ok: false, error: 'daily-log not configured' });
        const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return send(res, 400, { ok: false, error: 'invalid date (YYYY-MM-DD)' });
        }
        const body = await deps.dailyLog.read(date);
        return send(res, 200, { ok: true, date, body });
      }

      if (req.method === 'GET' && url.pathname === '/daily/dates') {
        if (!deps.dailyLog) return send(res, 503, { ok: false, error: 'daily-log not configured' });
        return send(res, 200, { ok: true, dates: await deps.dailyLog.listDates() });
      }

      if (req.method === 'GET' && url.pathname === '/daily/summary') {
        if (!deps.dailyLog) return send(res, 503, { ok: false, error: 'daily-log not configured' });
        return send(res, 200, { ok: true, ...(await deps.dailyLog.summary()) });
      }

      if (req.method === 'GET' && url.pathname === '/daily/latest') {
        if (!deps.dailyLog) return send(res, 503, { ok: false, error: 'daily-log not configured' });
        const n = Math.max(1, Math.min(365, parseInt(url.searchParams.get('n') ?? '3', 10)));
        return send(res, 200, { ok: true, n, body: await deps.dailyLog.latest(n) });
      }

      if (req.method === 'POST' && url.pathname === '/longterm/replace') {
        if (!deps.longterm) return send(res, 503, { ok: false, error: 'longterm not configured' });
        let payload: { body?: string };
        try { payload = (await readJson<{ body?: string }>(req, 6 * 1024 * 1024)).payload; }
        catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return send(res, /payload too large/.test(msg) ? 413 : 400, { ok: false, error: msg });
        }
        if (typeof payload.body !== 'string') return send(res, 400, { ok: false, error: 'body (string) required' });
        try {
          await deps.longterm.replace(payload.body);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return send(res, 413, { ok: false, error: msg });
        }
        return send(res, 200, { ok: true, bytes: deps.longterm.size() });
      }

      if (req.method === 'GET' && url.pathname === '/audit/kinds') {
        const sink = gateway.audit?.getInMemorySink();
        if (!sink) return send(res, 503, { ok: false, error: 'audit not configured' });
        const kinds = new Set<string>();
        for (const entry of sink.list({ limit: 10_000 })) kinds.add(entry.kind);
        return send(res, 200, { ok: true, kinds: [...kinds].sort() });
      }

      if (req.method === 'GET' && url.pathname === '/audit/count') {
        const sink = gateway.audit?.getInMemorySink();
        if (!sink) return send(res, 503, { ok: false, error: 'audit not configured' });
        const counts: Record<string, number> = {};
        for (const entry of sink.list({ limit: 10_000 })) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
        return send(res, 200, { ok: true, counts });
      }

      // ===== v3.3 Cirrus: embeddings / cost / tracing endpoints =====
      if (req.method === 'GET' && url.pathname === '/embeddings') {
        if (!deps.embeddings) return send(res, 503, { ok: false, error: 'embeddings not configured' });
        return send(res, 200, { ok: true, size: deps.embeddings.size() });
      }
      if (req.method === 'POST' && url.pathname === '/embeddings/add') {
        if (!deps.embeddings) return send(res, 503, { ok: false, error: 'embeddings not configured' });
        try {
          const { payload } = await readJson<{ id?: string; text?: string; meta?: Record<string, unknown> }>(req, 256 * 1024);
          if (!payload.id || !payload.text) return send(res, 400, { ok: false, error: 'id and text required' });
          const doc: { id: string; text: string; meta?: Record<string, unknown> } = { id: payload.id, text: payload.text };
          if (payload.meta !== undefined) doc.meta = payload.meta;
          await deps.embeddings.add(doc);
          return send(res, 200, { ok: true, size: deps.embeddings.size() });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }
      if (req.method === 'POST' && url.pathname === '/embeddings/search') {
        if (!deps.embeddings) return send(res, 503, { ok: false, error: 'embeddings not configured' });
        try {
          const { payload } = await readJson<{ query?: string; k?: number }>(req);
          if (!payload.query) return send(res, 400, { ok: false, error: 'query required' });
          const k = Math.max(1, Math.min(50, payload.k ?? 5));
          const results = await deps.embeddings.search(payload.query, k);
          return send(res, 200, { ok: true, results });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }
      if (req.method === 'GET' && url.pathname === '/cost/summary') {
        if (!deps.costTracker) return send(res, 503, { ok: false, error: 'cost tracker not configured' });
        const sessionId = url.searchParams.get('sessionId');
        const filter: { sessionId?: string } = sessionId ? { sessionId } : {};
        return send(res, 200, { ok: true, summary: deps.costTracker.summary(filter) });
      }
      if (req.method === 'GET' && url.pathname === '/trace/spans') {
        if (!deps.tracer) return send(res, 503, { ok: false, error: 'tracer not configured' });
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 50)));
        return send(res, 200, { ok: true, spans: deps.tracer.recent(limit) });
      }
      if (req.method === 'GET' && url.pathname === '/trace/size') {
        if (!deps.tracer) return send(res, 503, { ok: false, error: 'tracer not configured' });
        return send(res, 200, { ok: true, active: deps.tracer.size(), recent: deps.tracer.recent(1000).length });
      }

      // ===== v3.5 Cumulus: OpenClaw/Hermes parity =====
      // IDENTITY.md
      if (req.method === 'GET' && url.pathname === '/identity') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        return send(res, 200, { ok: true, body: await deps.workspace.readIdentity() });
      }
      if (req.method === 'POST' && url.pathname === '/identity') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        try {
          const { payload } = await readJson<{ body?: string }>(req, 32 * 1024);
          if (typeof payload.body !== 'string') return send(res, 400, { ok: false, error: 'body required' });
          await deps.workspace.writeIdentity(payload.body);
          return send(res, 200, { ok: true, bytes: Buffer.byteLength(payload.body, 'utf8') });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }

      // TOOLS.md (raw text)
      if (req.method === 'GET' && url.pathname === '/tools.md') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        return sendText(res, 200, 'text/markdown; charset=utf-8', await deps.workspace.readTools());
      }
      if (req.method === 'POST' && url.pathname === '/tools.md/regenerate') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        const snapshot = deps.tools.list().map((t) => ({ name: t.name, description: (t as { description?: string }).description ?? '' }));
        const body = await deps.workspace.regenerateTools(snapshot);
        return send(res, 200, { ok: true, tools: snapshot.length, bytes: Buffer.byteLength(body, 'utf8') });
      }

      // HEARTBEAT.md rules
      if (req.method === 'GET' && url.pathname === '/heartbeat/rules') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        return send(res, 200, { ok: true, rules: await deps.workspace.parseHeartbeatRules() });
      }

      // MEMORY.md index + memory/<topic>.md lazy loader
      if (req.method === 'GET' && url.pathname === '/memory/index') {
        if (!deps.memoryIndex) return send(res, 503, { ok: false, error: 'memoryIndex not configured' });
        return send(res, 200, { ok: true, ...(await deps.memoryIndex.readIndex()) });
      }
      if (req.method === 'GET' && url.pathname === '/memory/topics') {
        if (!deps.memoryIndex) return send(res, 503, { ok: false, error: 'memoryIndex not configured' });
        return send(res, 200, { ok: true, topics: await deps.memoryIndex.listTopics() });
      }
      const topicGetMatch = req.method === 'GET' && /^\/memory\/topic\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (topicGetMatch) {
        if (!deps.memoryIndex) return send(res, 503, { ok: false, error: 'memoryIndex not configured' });
        const body = await deps.memoryIndex.loadTopic(topicGetMatch[1]!);
        if (body === null) return send(res, 404, { ok: false, error: 'topic not found' });
        return sendText(res, 200, 'text/markdown; charset=utf-8', body);
      }
      const topicPostMatch = req.method === 'POST' && /^\/memory\/topic\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (topicPostMatch) {
        if (!deps.memoryIndex) return send(res, 503, { ok: false, error: 'memoryIndex not configured' });
        try {
          const { payload } = await readJson<{ body?: string }>(req, 256 * 1024);
          if (typeof payload.body !== 'string') return send(res, 400, { ok: false, error: 'body required' });
          const r = await deps.memoryIndex.saveTopic(topicPostMatch[1]!, payload.body);
          return send(res, 200, { ok: true, ...r });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }

      // Hermes-style skill library
      if (req.method === 'GET' && url.pathname === '/skills') {
        if (!deps.skills) return send(res, 503, { ok: false, error: 'skills not configured' });
        return send(res, 200, { ok: true, slugs: await deps.skills.listSlugs() });
      }
      if (req.method === 'GET' && url.pathname === '/skills/search') {
        if (!deps.skills) return send(res, 503, { ok: false, error: 'skills not configured' });
        const query = url.searchParams.get('q') ?? '';
        if (!query) return send(res, 400, { ok: false, error: 'q query parameter required' });
        const k = Math.max(1, Math.min(50, Number(url.searchParams.get('k') ?? 5)));
        return send(res, 200, { ok: true, results: await deps.skills.findRelevant(query, k) });
      }
      if (req.method === 'POST' && url.pathname === '/skills/extract') {
        if (!deps.skills) return send(res, 503, { ok: false, error: 'skills not configured' });
        try {
          const { payload } = await readJson<{ input?: string; output?: string; success?: boolean; name?: string; when?: string }>(req, 256 * 1024);
          if (!payload.input || !payload.output) return send(res, 400, { ok: false, error: 'input and output required' });
          const extractArgs: { input: string; output: string; success: boolean; name?: string; when?: string } = {
            input: payload.input,
            output: payload.output,
            success: payload.success ?? true
          };
          if (payload.name !== undefined) extractArgs.name = payload.name;
          if (payload.when !== undefined) extractArgs.when = payload.when;
          const skill = await deps.skills.extract(extractArgs);
          return send(res, 200, { ok: true, skill });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }
      const skillReadMatch = req.method === 'GET' && /^\/skills\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (skillReadMatch) {
        if (!deps.skills) return send(res, 503, { ok: false, error: 'skills not configured' });
        const s = await deps.skills.readOrNull(skillReadMatch[1]!);
        if (!s) return send(res, 404, { ok: false, error: 'skill not found' });
        return send(res, 200, { ok: true, skill: s });
      }

      // garud doctor
      if (req.method === 'GET' && url.pathname === '/doctor') {
        const { runDoctor } = await import('./doctor/doctor.js');
        const report = await runDoctor({
          config: deps.config,
          workspaceDir: deps.config.storage?.workspaceDir ?? './workspace',
          channelSecretsPresent: {
            whatsapp: !!deps.channelSecrets?.whatsapp,
            telegram: !!deps.channelSecrets?.telegram,
            discord: !!deps.channelSecrets?.discord,
            slack: !!deps.channelSecrets?.slack
          },
          toolCount: deps.tools.size()
        });
        return send(res, 200, report);
      }

      // ===== v3.4 Stratus: graph & crew run endpoints =====
      // POST /graph/run executes a small, declarative graph spec without
      // requiring code. Nodes can return a `nextState` patch + an optional
      // `done` flag to terminate. Useful for HTTP-only orchestration.
      if (req.method === 'POST' && url.pathname === '/graph/run') {
        try {
          const { payload } = await readJson<{
            initialState?: Record<string, unknown>;
            entry: string;
            maxSteps?: number;
            nodes: Array<{ id: string; patch?: Record<string, unknown>; setDone?: boolean }>;
            edges: Array<{ from: string; to: string; whenStateKey?: string; whenStateEquals?: unknown }>;
          }>(req, 64 * 1024);
          if (!payload.entry || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
            return send(res, 400, { ok: false, error: 'entry, nodes[], edges[] required' });
          }
          const { AgentGraph, END } = await import('./graph/agent-graph.js');
          const g = new AgentGraph<Record<string, unknown>>();
          for (const n of payload.nodes) {
            const patch = n.patch ?? {};
            const setDone = n.setDone === true;
            g.addNode(n.id, () => ({ ...patch, ...(setDone ? { __done: true } : {}) }));
          }
          for (const e of payload.edges) {
            const to = e.to === 'END' ? END : e.to;
            if (e.whenStateKey !== undefined) {
              const key = e.whenStateKey;
              const want = e.whenStateEquals;
              g.addEdge(e.from, to, (ctx) => (ctx.state as Record<string, unknown>)[key] === want);
            } else {
              g.addEdge(e.from, to);
            }
          }
          g.setEntry(payload.entry);
          const result = await g.run(payload.initialState ?? {}, { maxSteps: Math.min(64, payload.maxSteps ?? 16) });
          return send(res, 200, { ok: true, result });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }

      // POST /crew/run runs a roster of static-reply agents (no LLM required).
      // Each member contributes a fixed string; useful for templated workflows
      // and as a baseline for hooking in your own brain-backed handlers.
      if (req.method === 'POST' && url.pathname === '/crew/run') {
        try {
          const { payload } = await readJson<{
            goal: string;
            members: Array<{ name: string; role: string; reply: string; tools?: string[] }>;
            maxRounds?: number;
          }>(req, 64 * 1024);
          if (!payload.goal || !Array.isArray(payload.members) || payload.members.length === 0) {
            return send(res, 400, { ok: false, error: 'goal and members[] required' });
          }
          const { Crew } = await import('./crew/crew.js');
          const crew = new Crew();
          crew.setMaxTurns(Math.min(8, payload.maxRounds ?? 3));
          for (const m of payload.members) {
            crew.add({
              name: m.name,
              role: m.role,
              ...(m.tools ? { tools: m.tools } : {}),
              handler: () => m.reply
            });
          }
          const result = await crew.run(payload.goal);
          return send(res, 200, { ok: true, result });
        } catch (e) { return send(res, 400, { ok: false, error: (e as Error).message }); }
      }

      // ===== v3.0: heartbeat + workspace endpoints =====
      if (req.method === 'GET' && url.pathname === '/heartbeat') {
        if (!deps.heartbeat) return send(res, 503, { ok: false, error: 'heartbeat not configured' });
        const latest = deps.heartbeat.latest();
        return send(res, 200, {
          ok: true,
          running: deps.heartbeat.isRunning(),
          samples: deps.heartbeat.count(),
          latest
        });
      }

      if (req.method === 'POST' && url.pathname === '/heartbeat/beat') {
        if (!deps.heartbeat) return send(res, 503, { ok: false, error: 'heartbeat not configured' });
        return send(res, 200, { ok: true, sample: await deps.heartbeat.beat() });
      }

      if (req.method === 'GET' && url.pathname === '/soul') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        return send(res, 200, { ok: true, body: await deps.workspace.readSoul() });
      }

      if (req.method === 'POST' && url.pathname === '/soul') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        let payload: { body?: string };
        try { payload = (await readJson<{ body?: string }>(req, 300 * 1024)).payload; }
        catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (typeof payload.body !== 'string') return send(res, 400, { ok: false, error: 'body required' });
        try { await deps.workspace.writeSoul(payload.body); }
        catch (error) {
          return send(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/agents.md') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        return send(res, 200, { ok: true, body: await deps.workspace.readAgents() });
      }

      const userReadMatch = req.method === 'GET' && /^\/user\/[^/]+$/.test(url.pathname);
      if (userReadMatch) {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        const userId = decodeURIComponent(url.pathname.split('/')[2]!);
        return send(res, 200, { ok: true, userId, body: await deps.workspace.readUser(userId) });
      }

      const userWriteMatch = req.method === 'POST' && /^\/user\/[^/]+$/.test(url.pathname);
      if (userWriteMatch) {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        const userId = decodeURIComponent(url.pathname.split('/')[2]!);
        let payload: { body?: string };
        try { payload = (await readJson<{ body?: string }>(req, 80 * 1024)).payload; }
        catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (typeof payload.body !== 'string') return send(res, 400, { ok: false, error: 'body required' });
        try { await deps.workspace.writeUser(userId, payload.body); }
        catch (error) {
          return send(res, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return send(res, 200, { ok: true, userId });
      }

      if (req.method === 'GET' && url.pathname === '/users') {
        if (!deps.workspace) return send(res, 503, { ok: false, error: 'workspace not configured' });
        return send(res, 200, { ok: true, users: await deps.workspace.listUsers() });
      }

      // ===== v3.0/v3.4: channel adapters (with optional HMAC) =====
      const channelMatch = req.method === 'POST' && /^\/channel\/(whatsapp|telegram|discord|slack)$/.exec(url.pathname);
      if (channelMatch) {
        const channel = channelMatch[1] as 'whatsapp' | 'telegram' | 'discord' | 'slack';
        const { verifyHmac } = await import('./channels/hmac-verify.js');
        // Read raw body once so HMAC sees exactly the bytes the client sent.
        let raw: Buffer;
        try { raw = await readBody(req, 512 * 1024); }
        catch { return send(res, 413, { ok: false, error: 'payload too large' }); }

        // Channel-specific signature verification when a secret/key is set.
        const secret = deps.channelSecrets?.[channel];
        if (secret) {
          if (channel === 'slack') {
            const { verifySlackV0 } = await import('./channels/hmac-verify.js');
            const v = verifySlackV0(secret, raw, req.headers['x-slack-signature'] as string | string[] | undefined, req.headers['x-slack-request-timestamp'] as string | string[] | undefined);
            if (!v.ok) return send(res, 401, { ok: false, error: `slack-sig: ${v.reason}` });
          } else if (channel === 'discord') {
            const { verifyDiscordEd25519 } = await import('./channels/hmac-verify.js');
            const v = await verifyDiscordEd25519(secret, raw, req.headers['x-signature-ed25519'] as string | string[] | undefined, req.headers['x-signature-timestamp'] as string | string[] | undefined);
            if (!v.ok) return send(res, 401, { ok: false, error: `discord-sig: ${v.reason}` });
          } else {
            // WhatsApp / generic: plain HMAC-SHA256 over the body.
            const sig = (req.headers['x-hub-signature-256'] ?? req.headers['x-garud-signature']) as string | string[] | undefined;
            const v = verifyHmac(secret, raw, sig);
            if (!v.ok) return send(res, 401, { ok: false, error: `hmac: ${v.reason}` });
          }
        }

        let payload: unknown = {};
        if (raw.length > 0) {
          try { payload = JSON.parse(raw.toString('utf8')); }
          catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        }

        const accepted: string[] = [];
        if (channel === 'whatsapp') {
          const { parseWhatsApp } = await import('./channels/adapters/whatsapp-adapter.js');
          for (const m of parseWhatsApp(payload)) {
            try { accepted.push((await gateway.handleDetailed({ ...m, requestId })).requestId); } catch { /* skip */ }
          }
        } else if (channel === 'telegram') {
          const { parseTelegram } = await import('./channels/adapters/telegram-adapter.js');
          for (const m of parseTelegram(payload)) {
            try { accepted.push((await gateway.handleDetailed({ ...m, requestId })).requestId); } catch { /* skip */ }
          }
        } else if (channel === 'discord') {
          if ((payload as { type?: number })?.type === 1) return send(res, 200, { type: 1 });
          const { parseDiscord } = await import('./channels/adapters/discord-adapter.js');
          for (const m of parseDiscord(payload)) {
            try { accepted.push((await gateway.handleDetailed({ ...m, requestId })).requestId); } catch { /* skip */ }
          }
        } else {
          const { parseSlack } = await import('./channels/adapters/slack-adapter.js');
          const result = parseSlack(payload);
          if (result.challenge !== undefined) {
            return sendText(res, 200, 'text/plain; charset=utf-8', result.challenge);
          }
          for (const m of result.messages) {
            try { accepted.push((await gateway.handleDetailed({ ...m, requestId })).requestId); } catch { /* skip */ }
          }
        }
        return send(res, 200, { ok: true, accepted });
      }

      // v3.1: manual session compaction
      const sessionCompactMatch = req.method === 'POST' && /^\/sessions\/[^/]+\/compact$/.test(url.pathname);
      if (sessionCompactMatch) {
        const sessionId = url.pathname.split('/')[2]!;
        const session = gateway.sessions.get(sessionId);
        if (!session) return send(res, 404, { ok: false, error: 'session not found' });
        const conv = gateway.conversation;
        if (!conv) return send(res, 503, { ok: false, error: 'conversation store not configured' });
        // ConversationTurn stores both user input and assistant reply per record.
        // Expand each record into two turns for the compactor.
        const turns: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }> = [];
        for (const t of conv.list(sessionId)) {
          if (t.input) turns.push({ role: 'user', content: t.input });
          if (t.reply) turns.push({ role: 'assistant', content: t.reply });
        }
        const { ContextCompactor } = await import('./compaction/context-compactor.js');
        const compactor = new ContextCompactor();
        const plan = compactor.plan(turns);
        return send(res, 200, {
          ok: true,
          sessionId,
          before: turns.length,
          after: plan.kept.length,
          removed: plan.removed,
          summary: plan.summary || undefined,
          flushed: plan.flushed
        });
      }

      const hooksByEventMatch = req.method === 'GET' && /^\/hooks\/event\/[^/]+$/.test(url.pathname);
      if (hooksByEventMatch) {
        if (!deps.hooks) return send(res, 503, { ok: false, error: 'hooks not configured' });
        const event = decodeURIComponent(url.pathname.split('/')[3]!);
        return send(res, 200, { ok: true, event, hooks: deps.hooks.byEvent(event) });
      }

      const subAgentCancelMatch = req.method === 'POST' && /^\/sub-agents\/[^/]+\/cancel$/.test(url.pathname);
      if (subAgentCancelMatch) {
        if (!deps.subagent) return send(res, 503, { ok: false, error: 'subagent not configured' });
        const id = url.pathname.split('/')[2]!;
        return send(res, 200, { ok: true, cancelled: deps.subagent.cancel(id), duration: deps.subagent.jobDuration(id) });
      }

      if (req.method === 'POST' && url.pathname === '/sub-agents/prune') {
        if (!deps.subagent) return send(res, 503, { ok: false, error: 'subagent not configured' });
        const { payload } = await readJson<{ olderThanMs?: number }>(req);
        const raw = typeof payload.olderThanMs === 'number' ? payload.olderThanMs : 3_600_000;
        if (!Number.isFinite(raw) || raw < 0) {
          return send(res, 400, { ok: false, error: 'olderThanMs must be a non-negative number' });
        }
        return send(res, 200, { ok: true, pruned: deps.subagent.prune(raw) });
      }

      const nodeInvokeMatch = req.method === 'POST' && /^\/nodes\/[^/]+\/invoke$/.test(url.pathname);
      if (nodeInvokeMatch) {
        if (!deps.nodes) return send(res, 503, { ok: false, error: 'nodes not configured' });
        const id = url.pathname.split('/')[2]!;
        const node = deps.nodes.get(id);
        if (!node) return send(res, 404, { ok: false, error: 'unknown node' });
        let payload: { capability?: string; input?: unknown; timeoutMs?: number };
        try { payload = (await readJson<{ capability?: string; input?: unknown; timeoutMs?: number }>(req)).payload; }
        catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (!payload.capability) return send(res, 400, { ok: false, error: 'capability required' });
        if (!node.capabilities.includes(payload.capability)) {
          return send(res, 400, { ok: false, error: `node does not advertise ${payload.capability}` });
        }
        const requestedTimeout = payload.timeoutMs ?? 5_000;
        if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0) {
          return send(res, 400, { ok: false, error: 'timeoutMs must be a non-negative number' });
        }
        const timeoutMs = Math.min(30_000, Math.max(1, requestedTimeout));
        const inv = deps.nodes.invoke(id, payload.capability, payload.input ?? {});
        try {
          const settled = await deps.nodes.wait(inv.id, timeoutMs);
          return send(res, 200, { ok: true, invocation: settled });
        } catch {
          return send(res, 202, { ok: true, pending: true, invocationId: inv.id });
        }
      }

      const nodeDeleteMatch = req.method === 'DELETE' && /^\/nodes\/[^/]+$/.test(url.pathname);
      if (nodeDeleteMatch) {
        if (!deps.nodes) return send(res, 503, { ok: false, error: 'nodes not configured' });
        const id = url.pathname.split('/')[2]!;
        return send(res, 200, { ok: true, removed: deps.nodes.unregister(id) });
      }

      if (req.method === 'GET' && url.pathname === '/memories') {
        const sessionId = url.searchParams.get('sessionId');
        const query = url.searchParams.get('q');
        if (sessionId) {
          if (query) {
            const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') ?? '10', 10)));
            return send(res, 200, gateway.memories.searchWithScores(sessionId, query, { limit, fuzzy: true }));
          }
          return send(res, 200, gateway.memories.list(sessionId));
        }
        if (query) {
          const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') ?? '10', 10)));
          return send(res, 200, gateway.memories.searchAll(query, limit, { fuzzy: true }));
        }
        return send(res, 400, { ok: false, error: 'sessionId or q required' });
      }

      // Mutating endpoints (require write scope).
      if (isReadOnly) {
        return send(res, 403, { ok: false, error: 'read-only token' });
      }

      const sessForgetMatch = req.method === 'POST' && /^\/sessions\/[^/]+\/forget$/.test(url.pathname);
      if (sessForgetMatch) {
        const sid = url.pathname.split('/')[2]!;
        const memList = gateway.memories.list(sid);
        let removed = 0;
        for (const m of memList) {
          if (gateway.memories.remove(m.id)) removed++;
        }
        return send(res, 200, { ok: true, sessionId: sid, removed });
      }

      if (req.method === 'POST' && url.pathname === '/memories/import') {
        let payload: { memories?: unknown };
        try { payload = (await readJson<{ memories?: unknown }>(req)).payload; }
        catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (!Array.isArray(payload.memories)) {
          return send(res, 400, { ok: false, error: 'memories array required' });
        }
        const inserted = gateway.memories.importMemories(payload.memories);
        return send(res, 200, { ok: true, inserted });
      }

      if (req.method === 'POST' && url.pathname === '/trust') {
        const { payload } = await readJson<{ channel?: string; userId?: string; trust?: TrustLevel }>(req);
        if (!payload.channel || !payload.userId || !payload.trust) {
          return send(res, 400, { ok: false, error: 'channel, userId, trust required' });
        }
        const session = gateway.sessions.setTrust(payload.channel, payload.userId, payload.trust);
        return send(res, 200, { ok: !!session, session });
      }

      if (req.method === 'POST' && url.pathname === '/pairing/issue') {
        const { payload } = await readJson<{ channel?: string; userId?: string; trust?: TrustLevel }>(req);
        if (!payload.channel || !payload.userId || !payload.trust) {
          return send(res, 400, { ok: false, error: 'channel, userId, trust required' });
        }
        const result = gateway.issuePairing(payload.channel, payload.userId, payload.trust);
        if (!result) return send(res, 400, { ok: false, error: 'pairing disabled' });
        return send(res, 200, { ok: true, ...result });
      }

      if (req.method === 'POST' && url.pathname === '/pairing/redeem') {
        const { payload } = await readJson<{ code?: string }>(req);
        if (!payload.code) return send(res, 400, { ok: false, error: 'code required' });
        const result = gateway.redeemPairing(payload.code);
        return send(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && url.pathname === '/pairing/revoke') {
        const { payload } = await readJson<{ channel?: string; userId?: string }>(req);
        if (!payload.channel || !payload.userId) {
          return send(res, 400, { ok: false, error: 'channel, userId required' });
        }
        const removed = gateway.revokePairing(payload.channel, payload.userId);
        return send(res, 200, { ok: true, removed });
      }

      if (req.method === 'POST' && url.pathname === '/audit/replay') {
        const { payload } = await readJson<{ requestId?: string }>(req);
        if (!payload.requestId) return send(res, 400, { ok: false, error: 'requestId required' });
        const sink = gateway.audit?.getInMemorySink();
        const entries = sink?.list({ requestId: payload.requestId }) ?? [];
        const messageEntry = entries.find((e) => e.kind === 'message');
        if (!messageEntry || !messageEntry.sessionId) {
          return send(res, 404, { ok: false, error: 'not found' });
        }
        const session = gateway.sessions.get(messageEntry.sessionId);
        const original = (messageEntry.detail as { preview?: string }).preview;
        if (!session || !original) {
          return send(res, 400, { ok: false, error: 'cannot reconstruct request' });
        }
        const result = await gateway.handleDetailed({
          channel: session.channel,
          userId: session.userId,
          agentId: session.agentId,
          trustLevel: session.trustLevel,
          text: original,
          requestId: newRequestId()
        }, { noDeliver: true });
        return send(res, 200, {
          ok: true,
          original: payload.requestId,
          replay: result.requestId,
          reply: result.reply
        });
      }

      if (req.method === 'POST' && url.pathname === '/message') {
        let payload: IncomingMessage;
        try { payload = (await readJson<IncomingMessage>(req)).payload; }
        catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (!payload.text || !payload.channel || !payload.userId) {
          return send(res, 400, { ok: false, error: 'channel, userId, text required' });
        }
        try {
          const detail = await gateway.handleDetailed({ ...payload, requestId });
          const headers: Record<string, string> = {};
          if (detail.rateLimit) {
            headers['x-ratelimit-limit'] = String(detail.rateLimit.limit);
            headers['x-ratelimit-remaining'] = String(detail.rateLimit.remaining);
            headers['x-ratelimit-reset'] = String(detail.rateLimit.resetAt);
          }
          if (detail.rateLimited) {
            return send(res, 429, { ok: false, requestId: detail.requestId, reply: detail.reply }, headers);
          }
          return send(res, 200, {
            ok: true,
            requestId: detail.requestId,
            reply: detail.reply,
            duplicate: !!detail.duplicate
          }, headers);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (/required|invalid/i.test(msg)) {
            return send(res, 400, { ok: false, error: msg });
          }
          throw error;
        }
      }

      if (req.method === 'POST' && url.pathname === '/message/stream') {
        let payload: IncomingMessage;
        try { payload = (await readJson<IncomingMessage>(req)).payload; }
        catch { return send(res, 400, { ok: false, error: 'invalid JSON' }); }
        if (!payload.text || !payload.channel || !payload.userId) {
          return send(res, 400, { ok: false, error: 'channel, userId, text required' });
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-request-id': requestId
        });
        if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === 'function') {
          (res as unknown as { flushHeaders: () => void }).flushHeaders();
        }
        res.write(`event: start\ndata: ${JSON.stringify({ ts: Date.now(), requestId })}\n\n`);
        let aborted = false;
        req.on('close', () => { aborted = true; });
        try {
          const reply = await gateway.handle({ ...payload, requestId }, { noDeliver: true, requestId });
          if (aborted) return;
          // Word-boundary aware chunk split with hard cap to prevent runaway tokens.
          const chunks: string[] = [];
          const text = reply.text || '';
          const MAX = 80;
          if (text.length === 0) {
            chunks.push('');
          } else {
            let i = 0;
            while (i < text.length) {
              const remaining = text.length - i;
              if (remaining <= MAX) { chunks.push(text.slice(i)); break; }
              // Prefer to break at last whitespace within window for cleaner stream UX.
              const window = text.slice(i, i + MAX);
              const lastSpace = window.lastIndexOf(' ');
              const cut = lastSpace > MAX / 2 ? lastSpace + 1 : MAX;
              chunks.push(text.slice(i, i + cut));
              i += cut;
            }
          }
          for (const chunk of chunks) {
            if (aborted) break;
            res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
          }
          if (!aborted) res.write(`event: done\ndata: ${JSON.stringify(reply)}\n\n`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (!aborted) res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
        }
        res.end();
        return;
      }

      send(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('request failed', { path: url.pathname, error: message, requestId });
      send(res, 500, { ok: false, error: message, requestId });
    } finally {
      log.debug('request done', { path: url.pathname, ms: Date.now() - startedAt, requestId });
    }
  });

  return server;
}
