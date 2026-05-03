import { escapeHtml } from '../utils/text.js';

/**
 * Tiny built-in dashboard rendered as a single HTML page. Every dynamic value
 * is HTML-escaped to avoid injection if config or stats happen to contain
 * untrusted content.
 */
export function renderDashboard(stats: {
  agent: string;
  brain: string;
  version: string;
  handled: number;
  rateLimited: number;
  duplicates: number;
  errors: number;
  sessions: number;
  memories: number;
  channels: string[];
  tools: number;
  cache?: { hits: number; misses: number; size: number; enabled: boolean } | undefined;
  ws?: number;
  conversations?: number;
}): string {
  const e = escapeHtml;
  const cacheRow = stats.cache
    ? `<tr><th>Cache</th><td>${stats.cache.enabled ? 'on' : 'off'} · ${stats.cache.hits}/${stats.cache.misses} hits/miss · size ${stats.cache.size}</td></tr>`
    : '';
  const wsRow = stats.ws !== undefined
    ? `<tr><th>WS clients</th><td>${stats.ws}</td></tr>`
    : '';
  const convRow = stats.conversations !== undefined
    ? `<tr><th>Conversation turns</th><td>${stats.conversations}</td></tr>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Garud Agent · ${e(stats.agent)}</title>
<style>
  body { font: 14px/1.5 system-ui, -apple-system, sans-serif; max-width: 720px; margin: 32px auto; padding: 0 16px; color: #1f2933; }
  h1 { margin-bottom: 4px; }
  .sub { color: #6b7280; margin-bottom: 24px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  th { width: 35%; color: #374151; font-weight: 600; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
           background: #dbeafe; color: #1d4ed8; }
  footer { color: #9ca3af; font-size: 12px; margin-top: 32px; }
  .row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .card { flex: 1 1 200px; padding: 12px; border: 1px solid #e5e7eb; border-radius: 6px; }
  .num { font-size: 22px; font-weight: 600; }
</style>
</head>
<body>
<h1>${e(stats.agent)} <span class="badge">v${e(stats.version)}</span></h1>
<div class="sub">Local-first agent gateway · brain=<code>${e(stats.brain)}</code></div>

<div class="row">
  <div class="card"><div class="num">${stats.handled}</div>messages handled</div>
  <div class="card"><div class="num">${stats.sessions}</div>sessions</div>
  <div class="card"><div class="num">${stats.memories}</div>memories</div>
  <div class="card"><div class="num">${stats.tools}</div>tools</div>
</div>

<table>
<tr><th>Brain</th><td><code>${e(stats.brain)}</code></td></tr>
<tr><th>Channels</th><td>${stats.channels.map((c) => `<code>${e(c)}</code>`).join(' ') || '—'}</td></tr>
<tr><th>Rate-limited</th><td>${stats.rateLimited}</td></tr>
<tr><th>Duplicates</th><td>${stats.duplicates}</td></tr>
<tr><th>Errors</th><td>${stats.errors}</td></tr>
${cacheRow}
${convRow}
${wsRow}
</table>

<table>
<tr><th>Endpoints</th><td>
<code>GET /health</code> · <code>GET /ready</code><br>
<code>GET /sessions</code> · <code>GET /sessions/&lt;id&gt;/history</code><br>
<code>GET /tools</code> · <code>GET /stats</code><br>
<code>GET /audit?limit=&amp;sessionId=&amp;kind=&amp;requestId=</code><br>
<code>GET /memories?sessionId=</code> or <code>?q=</code><br>
<code>GET /metrics</code> (Prometheus)<br>
<code>POST /message</code> · <code>POST /message/stream</code> (SSE)<br>
<code>POST /trust</code> · <code>POST /pairing/issue</code> · <code>POST /pairing/redeem</code> · <code>POST /pairing/revoke</code><br>
<code>POST /webhook/&lt;channel&gt;</code> (HMAC if configured)<br>
<code>POST /audit/replay</code><br>
<code>WS /ws</code>
</td></tr>
</table>

<footer>Garud Agent · MIT · refresh to update</footer>
</body>
</html>`;
}
