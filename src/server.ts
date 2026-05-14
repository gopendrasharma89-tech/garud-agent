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
