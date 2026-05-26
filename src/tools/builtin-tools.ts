import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { ToolDefinition } from '../types.js';
import { MemoryStore } from '../core/memory-store.js';
import { lineDiff } from '../utils/text.js';
import { withTimeout } from '../utils/timeout.js';
import { evaluateExpression } from './math-eval.js';

export interface BuiltinToolDeps {
  memories: MemoryStore;
  fetchTimeoutMs?: number;
  fetchMaxBytes?: number;
  longterm?: import('../longterm/longterm-memory.js').LongTermMemory;
  dailyLog?: import('../longterm/daily-log.js').DailyLog;
  subagent?: import('../subagent/subagent-runner.js').SubAgentRunner;
  nodes?: import('../nodes/node-registry.js').NodeRegistry;
  hooks?: import('../hooks/hook-runner.js').HookRunner;
  compactor?: import('../compaction/context-compactor.js').ContextCompactor;
  workspace?: import('../workspace/workspace-files.js').WorkspaceFiles;
  heartbeat?: import('../heartbeat/heartbeat.js').Heartbeat;
  auditSink?: { list(filter?: { limit?: number; kind?: string }): Array<{ kind: string; ts: number }> };
  skillsLoader?: { list(): Array<{ name: string; description: string; tags: string[] }>; read(name: string): string | undefined };
  embeddings?: import('../embeddings/embedding-store.js').EmbeddingStore;
  embeddingPersistence?: import('../embeddings/embedding-persistence.js').EmbeddingPersistence;
  costTracker?: import('../cost/cost-tracker.js').CostTracker;
  tracer?: import('../tracing/span.js').Tracer;
  reflector?: { revise(answer: string, goal?: string): Promise<{ output: string; iterations: number; accepted: boolean; critiques: string[] }> };
  planner?: import('../planning/planner.js').HeuristicPlanner;
  memoryIndex?: import('../memory/memory-index.js').MemoryIndex;
  skillLibrary?: import('../skills/skill-library.js').SkillLibrary;
}

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolDefinition[] {
  const fetchTimeout = deps.fetchTimeoutMs ?? 5000;
  const fetchMaxBytes = deps.fetchMaxBytes ?? 4096;

  return [
    {
      name: 'memory.save',
      description: 'Save a durable note in the current session memory.',
      tags: ['write', 'memory'],
      inputHint: 'free text to remember',
      execute: (input, ctx) => {
        const trimmed = input.trim();
        if (!trimmed) return { content: 'memory.save: empty input', error: true };
        const saved = deps.memories.save(ctx.session.id, trimmed, ['user-note'], 0.7);
        return { content: `saved memory ${saved.id.slice(0, 8)}: ${trimmed}` };
      }
    },
    {
      name: 'memory.search',
      description: 'Search memories within the current session.',
      tags: ['read', 'memory', 'safe'],
      cacheable: true,
      execute: (input, ctx) => {
        const items = deps.memories.search(ctx.session.id, input, 5);
        if (!items.length) return { content: 'no memory hits' };
        return { content: items.map((m) => `• ${m.text}`).join('\n'), metadata: { count: items.length } };
      }
    },
    {
      name: 'memory.list',
      description: 'List up to N most recent memories for the current session.',
      tags: ['read', 'memory', 'safe'],
      execute: (input, ctx) => {
        const limit = Math.max(1, Math.min(20, parseInt(input, 10) || 5));
        const items = deps.memories.list(ctx.session.id)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, limit);
        if (!items.length) return { content: 'no memories yet' };
        return { content: items.map((m) => `• ${m.text}`).join('\n') };
      }
    },
    {
      name: 'memory.forget',
      description: 'Delete a memory by id.',
      tags: ['write', 'memory', 'destructive'],
      execute: (input) => {
        const removed = deps.memories.remove(input.trim());
        return { content: removed ? 'forgotten' : 'not found' };
      }
    },
    {
      name: 'memory.pin',
      description: 'Pin a memory by id (never evicted by capacity).',
      tags: ['write', 'memory'],
      execute: (input) => {
        const m = deps.memories.pin(input.trim(), true);
        return m ? { content: `pinned ${m.id.slice(0, 8)}` } : { content: 'not found', error: true };
      }
    },
    {
      name: 'memory.unpin',
      description: 'Unpin a memory by id.',
      tags: ['write', 'memory'],
      execute: (input) => {
        const m = deps.memories.pin(input.trim(), false);
        return m ? { content: `unpinned ${m.id.slice(0, 8)}` } : { content: 'not found', error: true };
      }
    },
    {
      name: 'memory.searchAll',
      description: 'Search memories across all sessions (read-only).',
      tags: ['read', 'memory', 'safe'],
      cacheable: true,
      execute: (input) => {
        const items = deps.memories.searchAll(input, 5, { fuzzy: true });
        if (!items.length) return { content: 'no memory hits' };
        return {
          content: items.map((r) => `• [${r.memory.sessionId.slice(0, 8)}] ${r.memory.text}`).join('\n'),
          metadata: { count: items.length }
        };
      }
    },
    {
      name: 'status',
      description: 'Return runtime health summary.',
      tags: ['read', 'safe'],
      execute: () => ({ content: 'gateway=ok tools=ok policy=ok' })
    },
    {
      name: 'time.now',
      description: 'Return the current UTC time.',
      tags: ['read', 'safe'],
      aliases: ['now', 'current-time'],
      execute: () => ({
        content: new Date().toISOString(),
        metadata: { unix: Math.floor(Date.now() / 1000) }
      })
    },
    {
      name: 'echo',
      description: 'Echo the provided text back unchanged.',
      tags: ['safe'],
      execute: (input) => ({ content: input })
    },
    {
      name: 'math.eval',
      description: 'Evaluate a safe arithmetic expression.',
      tags: ['read', 'safe'],
      aliases: ['calc', 'calculate'],
      cacheable: true,
      execute: (input) => {
        try {
          return { content: String(evaluateExpression(input)) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `math error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'http.fetch',
      description: 'Fetch a URL via HTTP GET and return up to 4KB of body text.',
      tags: ['read', 'network'],
      cacheable: true,
      execute: async (input, ctx) => {
        const url = input.trim();
        if (!/^https?:\/\//i.test(url)) {
          return { content: 'http.fetch: invalid URL', error: true };
        }
        try {
          const fetchFn = globalThis.fetch;
          if (!fetchFn) return { content: 'fetch unavailable', error: true };
          const response = await withTimeout(fetchFn(url, { signal: ctx.signal }), fetchTimeout);
          const body = await response.text();
          const trimmed = body.length > fetchMaxBytes ? body.slice(0, fetchMaxBytes) + '…' : body;
          return {
            content: trimmed,
            metadata: {
              status: response.status,
              contentType: response.headers.get('content-type') ?? '',
              bytes: body.length
            }
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `http.fetch error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'session.info',
      description: 'Describe the current session.',
      tags: ['read', 'safe'],
      execute: (_input, ctx) => ({
        content: JSON.stringify({
          id: ctx.session.id,
          userId: ctx.session.userId,
          channel: ctx.session.channel,
          agentId: ctx.session.agentId,
          trustLevel: ctx.session.trustLevel,
          messageCount: ctx.session.messageCount,
          sandbox: ctx.sandbox ?? false
        })
      })
    },
    {
      name: 'random.uuid',
      description: 'Generate a random UUID v4.',
      tags: ['read', 'safe'],
      execute: () => ({ content: randomUUID() })
    },
    {
      name: 'random.number',
      description: 'Random integer; input "<min> <max>" inclusive (default 1 100).',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.trim().split(/\s+/).map(Number).filter((n) => !Number.isNaN(n));
        const min = Math.floor(parts[0] ?? 1);
        const max = Math.floor(parts[1] ?? 100);
        if (min > max) return { content: 'random.number: min > max', error: true };
        return { content: String(randomInt(min, max + 1)) };
      }
    },
    {
      name: 'random.bytes',
      description: 'Generate N random bytes returned as hex.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const n = Math.max(1, Math.min(256, parseInt(input.trim(), 10) || 16));
        return { content: randomBytes(n).toString('hex') };
      }
    },
    {
      name: 'base64.encode',
      description: 'Encode UTF-8 text to base64.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({ content: Buffer.from(input, 'utf8').toString('base64') })
    },
    {
      name: 'base64.decode',
      description: 'Decode base64 text to UTF-8.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        try {
          return { content: Buffer.from(input.trim(), 'base64').toString('utf8') };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `base64.decode error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'hash.sha256',
      description: 'Lowercase hex SHA-256 digest.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({ content: createHash('sha256').update(input, 'utf8').digest('hex') })
    },
    {
      name: 'hash.md5',
      description: 'Lowercase hex MD5 digest.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({ content: createHash('md5').update(input, 'utf8').digest('hex') })
    },
    {
      name: 'json.parse',
      description: 'Parse JSON and return a stable, indented re-stringification.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        try {
          const value = JSON.parse(input);
          return { content: JSON.stringify(value, null, 2) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `json.parse error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'regex.match',
      description: 'Test "<pattern>::<text>"; returns matches as JSON array.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'regex.match: missing :: separator', error: true };
        const pattern = input.slice(0, sep);
        const text = input.slice(sep + 2);
        try {
          const re = new RegExp(pattern, 'g');
          const matches = [...text.matchAll(re)].map((m) => m[0]);
          return { content: JSON.stringify(matches), metadata: { count: matches.length } };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `regex.match error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'regex.replace',
      description: 'Apply "<pattern>::<replacement>::<text>" and return the result.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        const parts = input.split('::');
        if (parts.length < 3) return { content: 'regex.replace: needs <pattern>::<replacement>::<text>', error: true };
        const [pattern, replacement, ...rest] = parts;
        const text = rest.join('::');
        try {
          const re = new RegExp(pattern!, 'g');
          return { content: text.replace(re, replacement!) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `regex.replace error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'url.parse',
      description: 'Parse a URL and return its components as JSON.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        try {
          const u = new URL(input.trim());
          return {
            content: JSON.stringify({
              protocol: u.protocol, hostname: u.hostname, port: u.port,
              pathname: u.pathname, search: u.search, hash: u.hash
            })
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `url.parse error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'url.encode',
      description: 'URL-encode the input.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({ content: encodeURIComponent(input) })
    },
    {
      name: 'url.decode',
      description: 'URL-decode the input.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        try {
          return { content: decodeURIComponent(input) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `url.decode error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'date.parse',
      description: 'Parse a date string and return ISO + unix seconds.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        const ts = Date.parse(input.trim());
        if (Number.isNaN(ts)) return { content: 'date.parse: invalid date', error: true };
        return {
          content: new Date(ts).toISOString(),
          metadata: { unix: Math.floor(ts / 1000) }
        };
      }
    },
    {
      name: 'date.add',
      description: 'Add an interval to "now" or to "<iso>::<interval>" (e.g. 5m, 2h, 1d).',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        try {
          const sep = input.indexOf('::');
          let baseMs: number;
          let interval: string;
          if (sep === -1) {
            baseMs = Date.now();
            interval = input.trim();
          } else {
            baseMs = Date.parse(input.slice(0, sep).trim());
            interval = input.slice(sep + 2).trim();
            if (Number.isNaN(baseMs)) return { content: 'date.add: invalid base date', error: true };
          }
          const match = /^(\-?\d+)\s*(ms|s|m|h|d)?$/i.exec(interval);
          if (!match) return { content: 'date.add: invalid interval', error: true };
          const n = Number(match[1]);
          const unit = (match[2] ?? 'ms').toLowerCase();
          const factor: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
          const result = new Date(baseMs + n * (factor[unit] ?? 1));
          return { content: result.toISOString(), metadata: { unix: Math.floor(result.getTime() / 1000) } };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `date.add error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.length',
      description: 'Return character and word counts for the input.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({
        content: JSON.stringify({
          chars: input.length,
          words: input.trim() ? input.trim().split(/\s+/).length : 0,
          lines: input ? input.split('\n').length : 0
        })
      })
    },
    {
      name: 'text.upper',
      description: 'Uppercase the input text.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({ content: input.toUpperCase() })
    },
    {
      name: 'text.lower',
      description: 'Lowercase the input text.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({ content: input.toLowerCase() })
    },
    {
      name: 'text.reverse',
      description: 'Reverse the input text by codepoint.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => ({ content: [...input].reverse().join('') })
    },
    {
      name: 'text.diff',
      description: 'Unified-style line diff of "<a>::<b>".',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'text.diff: needs <a>::<b>', error: true };
        return { content: lineDiff(input.slice(0, sep), input.slice(sep + 2)) };
      }
    },
    {
      name: 'text.normalize',
      description: 'Unicode-normalize the input (NFC by default; pass mode after ::).',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        try {
          const sep = input.indexOf('::');
          const text = sep === -1 ? input : input.slice(0, sep);
          const mode = (sep === -1 ? 'NFC' : input.slice(sep + 2).trim().toUpperCase()) as 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
          if (!['NFC', 'NFD', 'NFKC', 'NFKD'].includes(mode)) {
            return { content: 'text.normalize: invalid mode', error: true };
          }
          return { content: text.normalize(mode) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `text.normalize error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'csv.parse',
      description: 'Parse a small CSV (no quoted commas) into a JSON array of objects.',
      tags: ['read', 'safe'],
      cacheable: true,
      execute: (input) => {
        try {
          const lines = input.split(/\r?\n/).filter((l) => l.length);
          if (!lines.length) return { content: '[]' };
          const header = lines[0]!.split(',').map((s) => s.trim());
          const rows: Array<Record<string, string>> = lines.slice(1).map((line) => {
            const fields = line.split(',');
            const obj: Record<string, string> = {};
            for (let i = 0; i < header.length; i++) obj[header[i]!] = (fields[i] ?? '').trim();
            return obj;
          });
          return { content: JSON.stringify(rows), metadata: { rows: rows.length } };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `csv.parse error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'password.hash',
      description: 'Hash a password with scrypt; returns "salt$hash" hex form.',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          if (!input) return { content: 'password.hash: empty input', error: true };
          const salt = randomBytes(16);
          const derived = scryptSync(input, salt, 32);
          return { content: `${salt.toString('hex')}$${derived.toString('hex')}` };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `password.hash error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'password.verify',
      description: 'Verify "<password>::<salt$hash>"; returns "true" or "false".',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          const sep = input.indexOf('::');
          if (sep === -1) return { content: 'password.verify: needs <pw>::<salt$hash>', error: true };
          const pw = input.slice(0, sep);
          const stored = input.slice(sep + 2);
          const [saltHex, hashHex] = stored.split('$');
          if (!saltHex || !hashHex) return { content: 'password.verify: malformed stored value', error: true };
          const salt = Buffer.from(saltHex, 'hex');
          const expected = Buffer.from(hashHex, 'hex');
          const derived = scryptSync(pw, salt, expected.length);
          const match = expected.length === derived.length && timingSafeEqual(expected, derived);
          return { content: match ? 'true' : 'false' };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `password.verify error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'crypto.encrypt',
      description: 'AES-256-GCM encrypt "<key>::<plaintext>". Key derived via scrypt; output is hex(iv|tag|cipher).',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          const sep = input.indexOf('::');
          if (sep === -1) return { content: 'crypto.encrypt: needs <key>::<plaintext>', error: true };
          const key = scryptSync(input.slice(0, sep), 'garud-aead', 32);
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          const enc = Buffer.concat([cipher.update(Buffer.from(input.slice(sep + 2), 'utf8')), cipher.final()]);
          const tag = cipher.getAuthTag();
          return { content: Buffer.concat([iv, tag, enc]).toString('hex') };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `crypto.encrypt error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'crypto.decrypt',
      description: 'AES-256-GCM decrypt "<key>::<hex>"; reverse of crypto.encrypt.',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          const sep = input.indexOf('::');
          if (sep === -1) return { content: 'crypto.decrypt: needs <key>::<hex>', error: true };
          const key = scryptSync(input.slice(0, sep), 'garud-aead', 32);
          const buf = Buffer.from(input.slice(sep + 2), 'hex');
          if (buf.length < 28) return { content: 'crypto.decrypt: payload too short', error: true };
          const iv = buf.slice(0, 12);
          const tag = buf.slice(12, 28);
          const enc = buf.slice(28);
          const decipher = createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(tag);
          const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
          return { content: dec.toString('utf8') };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `crypto.decrypt error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.slugify',
      description: 'Convert text to URL-safe slug (lowercase, hyphenated, ASCII only).',
      tags: ['read', 'safe'],
      execute: (input) => {
        const slug = input
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 200);
        return { content: slug || '-' };
      }
    },
    {
      name: 'text.template',
      description: 'Render a {{var}} template. Input: "<template>::<json-vars>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'text.template: needs <template>::<json-vars>', error: true };
        const template = input.slice(0, sep);
        try {
          const vars = JSON.parse(input.slice(sep + 2)) as Record<string, unknown>;
          if (!vars || typeof vars !== 'object') return { content: 'text.template: vars must be object', error: true };
          const out = template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
            const parts = key.split('.');
            let v: unknown = vars;
            for (const p of parts) {
              if (v && typeof v === 'object' && p in (v as Record<string, unknown>)) {
                v = (v as Record<string, unknown>)[p];
              } else { return ''; }
            }
            return v === undefined || v === null ? '' : String(v);
          });
          return { content: out };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `text.template error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'string.distance',
      description: 'Levenshtein distance between two strings: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'string.distance: needs <a>::<b>', error: true };
        const a = input.slice(0, sep);
        const b = input.slice(sep + 2);
        if (a.length > 2000 || b.length > 2000) return { content: 'string.distance: inputs too long', error: true };
        const m = a.length, n = b.length;
        if (m === 0) return { content: String(n) };
        if (n === 0) return { content: String(m) };
        let prev = new Array(n + 1).fill(0).map((_, j) => j);
        let curr = new Array(n + 1).fill(0);
        for (let i = 1; i <= m; i++) {
          curr[0] = i;
          for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
          }
          [prev, curr] = [curr, prev];
        }
        return { content: String(prev[n]) };
      }
    },
    {
      name: 'json.path',
      description: 'Extract value via dot path. Input: "<json>::<path>" e.g. data::a.b.0.c',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'json.path: needs <json>::<path>', error: true };
        try {
          const obj = JSON.parse(input.slice(0, sep));
          const path = input.slice(sep + 2).trim();
          if (!path) return { content: JSON.stringify(obj) };
          let cur: unknown = obj;
          for (const part of path.split('.')) {
            if (cur === null || cur === undefined) return { content: 'null' };
            if (Array.isArray(cur)) {
              const idx = parseInt(part, 10);
              if (Number.isNaN(idx)) return { content: 'json.path: invalid index', error: true };
              cur = cur[idx];
            } else if (typeof cur === 'object') {
              cur = (cur as Record<string, unknown>)[part];
            } else {
              return { content: 'undefined' };
            }
          }
          return { content: typeof cur === 'string' ? cur : JSON.stringify(cur) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `json.path error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.unique',
      description: 'Deduplicate a JSON array, preserving order.',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          const arr = JSON.parse(input);
          if (!Array.isArray(arr)) return { content: 'array.unique: not an array', error: true };
          const seen = new Set<string>();
          const out: unknown[] = [];
          for (const item of arr) {
            const key = typeof item === 'object' ? JSON.stringify(item) : String(item);
            if (!seen.has(key)) { seen.add(key); out.push(item); }
          }
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.unique error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.flatten',
      description: 'Flatten a nested JSON array. Input: "<json>" (1 level) or "<json>::<depth>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        let arrStr = input;
        let depth = 1;
        if (sep !== -1) {
          const maybeDepth = parseInt(input.slice(sep + 2), 10);
          if (Number.isFinite(maybeDepth) && maybeDepth >= 0 && maybeDepth <= 32) {
            arrStr = input.slice(0, sep);
            depth = maybeDepth;
          }
        }
        try {
          const arr = JSON.parse(arrStr);
          if (!Array.isArray(arr)) return { content: 'array.flatten: not an array', error: true };
          const out = (arr as unknown[]).flat(depth);
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.flatten error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'random.pick',
      description: 'Pick a random element from a JSON array.',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          const arr = JSON.parse(input);
          if (!Array.isArray(arr) || arr.length === 0) return { content: 'random.pick: empty or non-array', error: true };
          const idx = randomInt(0, arr.length);
          const item = arr[idx];
          return { content: typeof item === 'string' ? item : JSON.stringify(item) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `random.pick error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'time.diff',
      description: 'Difference between two ISO timestamps in ms. Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'time.diff: needs <a>::<b>', error: true };
        const a = Date.parse(input.slice(0, sep));
        const b = Date.parse(input.slice(sep + 2));
        if (Number.isNaN(a) || Number.isNaN(b)) return { content: 'time.diff: invalid date', error: true };
        return { content: String(b - a) };
      }
    },
    {
      name: 'time.format',
      description: 'Format a timestamp (epoch ms or ISO) as "<ts>::<format>". Formats: iso, date, time, unix.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        const tsStr = sep === -1 ? input : input.slice(0, sep);
        const fmt = sep === -1 ? 'iso' : input.slice(sep + 2).trim() || 'iso';
        const tsNum = Number(tsStr);
        const ms = Number.isFinite(tsNum) ? tsNum : Date.parse(tsStr);
        if (Number.isNaN(ms)) return { content: 'time.format: invalid timestamp', error: true };
        const d = new Date(ms);
        const pad = (n: number, w = 2) => String(n).padStart(w, '0');
        switch (fmt) {
          case 'iso': return { content: d.toISOString() };
          case 'date': return { content: d.toISOString().slice(0, 10) };
          case 'time': return { content: d.toISOString().slice(11, 19) };
          case 'unix': return { content: String(Math.floor(ms / 1000)) };
          case 'rfc2822': return { content: d.toUTCString() };
          case 'long': return {
            content: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
          };
          default: return { content: `time.format: unknown format "${fmt}"`, error: true };
        }
      }
    },
    {
      name: 'array.sort',
      description: 'Sort a JSON array. Input: "<json>::asc|desc|num-asc|num-desc".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        const arrStr = sep === -1 ? input : input.slice(0, sep);
        const order = sep === -1 ? 'asc' : input.slice(sep + 2).trim() || 'asc';
        try {
          const arr = JSON.parse(arrStr);
          if (!Array.isArray(arr)) return { content: 'array.sort: not an array', error: true };
          const out = [...arr];
          if (order === 'asc') out.sort((a, b) => String(a).localeCompare(String(b)));
          else if (order === 'desc') out.sort((a, b) => String(b).localeCompare(String(a)));
          else if (order === 'num-asc') out.sort((a, b) => Number(a) - Number(b));
          else if (order === 'num-desc') out.sort((a, b) => Number(b) - Number(a));
          else return { content: `array.sort: unknown order "${order}"`, error: true };
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.sort error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.chunk',
      description: 'Split a JSON array into chunks. Input: "<json>::<size>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'array.chunk: needs <json>::<size>', error: true };
        try {
          const arr = JSON.parse(input.slice(0, sep));
          const size = parseInt(input.slice(sep + 2), 10);
          if (!Array.isArray(arr)) return { content: 'array.chunk: not an array', error: true };
          if (!Number.isFinite(size) || size < 1 || size > 10_000) {
            return { content: 'array.chunk: invalid size', error: true };
          }
          const out: unknown[][] = [];
          for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.chunk error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.zip',
      description: 'Zip two JSON arrays into pairs. Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'array.zip: needs <a>::<b>', error: true };
        try {
          const a = JSON.parse(input.slice(0, sep));
          const b = JSON.parse(input.slice(sep + 2));
          if (!Array.isArray(a) || !Array.isArray(b)) return { content: 'array.zip: both must be arrays', error: true };
          const len = Math.min(a.length, b.length);
          const out: unknown[][] = [];
          for (let i = 0; i < len; i++) out.push([a[i], b[i]]);
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.zip error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.wordcount',
      description: 'Count words, characters, and lines in text.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const words = input.trim().length === 0 ? 0 : input.trim().split(/\s+/).length;
        const chars = input.length;
        const lines = input.length === 0 ? 0 : input.split(/\n/).length;
        return { content: JSON.stringify({ words, chars, lines }) };
      }
    },
    {
      name: 'text.truncate',
      description: 'Truncate text to N chars with ellipsis. Input: "<text>::<max>". Uses last "::" only when tail is numeric.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        if (sep === -1) return { content: 'text.truncate: needs <text>::<max>', error: true };
        const tail = input.slice(sep + 2).trim();
        const max = parseInt(tail, 10);
        if (!/^\d+$/.test(tail) || !Number.isFinite(max) || max < 1) {
          return { content: 'text.truncate: invalid max', error: true };
        }
        const text = input.slice(0, sep);
        if (text.length <= max) return { content: text };
        return { content: text.slice(0, Math.max(0, max - 1)) + '…' };
      }
    },
    {
      name: 'text.repeat',
      description: 'Repeat a string. Input: "<text>::<count>". Uses last "::" only when tail is numeric.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        if (sep === -1) return { content: 'text.repeat: needs <text>::<count>', error: true };
        const tail = input.slice(sep + 2).trim();
        const count = parseInt(tail, 10);
        if (!/^\d+$/.test(tail) || !Number.isFinite(count) || count < 0 || count > 10_000) {
          return { content: 'text.repeat: invalid count (0-10000)', error: true };
        }
        const text = input.slice(0, sep);
        if (text.length * count > 1_000_000) return { content: 'text.repeat: output too large', error: true };
        return { content: text.repeat(count) };
      }
    },
    {
      name: 'math.stats',
      description: 'Compute min/max/mean/median/stddev for a JSON array of numbers.',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          const arr = JSON.parse(input);
          if (!Array.isArray(arr) || arr.length === 0) return { content: 'math.stats: empty or non-array', error: true };
          const nums = arr.map((x) => Number(x));
          if (nums.some((n) => !Number.isFinite(n))) return { content: 'math.stats: non-numeric value', error: true };
          const sorted = [...nums].sort((a, b) => a - b);
          const min = sorted[0];
          const max = sorted[sorted.length - 1];
          const sum = nums.reduce((a, b) => a + b, 0);
          const mean = sum / nums.length;
          const mid = Math.floor(sorted.length / 2);
          const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
          const variance = nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / nums.length;
          const stddev = Math.sqrt(variance);
          return { content: JSON.stringify({ count: nums.length, min, max, sum, mean, median, stddev }) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `math.stats error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'json.merge',
      description: 'Deep-merge two JSON objects. Input: "<a>::<b>". Right-side wins.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'json.merge: needs <a>::<b>', error: true };
        try {
          const a = JSON.parse(input.slice(0, sep));
          const b = JSON.parse(input.slice(sep + 2));
          const merge = (x: unknown, y: unknown): unknown => {
            if (x && typeof x === 'object' && !Array.isArray(x) && y && typeof y === 'object' && !Array.isArray(y)) {
              const out: Record<string, unknown> = { ...(x as Record<string, unknown>) };
              for (const [k, v] of Object.entries(y as Record<string, unknown>)) {
                out[k] = k in out ? merge(out[k], v) : v;
              }
              return out;
            }
            return y;
          };
          return { content: JSON.stringify(merge(a, b)) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `json.merge error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'json.diff',
      description: 'Find changed keys between two JSON objects. Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'json.diff: needs <a>::<b>', error: true };
        try {
          const a = JSON.parse(input.slice(0, sep)) as Record<string, unknown>;
          const b = JSON.parse(input.slice(sep + 2)) as Record<string, unknown>;
          if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
            return { content: 'json.diff: both must be objects', error: true };
          }
          const added: string[] = [], removed: string[] = [], changed: string[] = [];
          for (const k of Object.keys(b)) {
            if (!(k in a)) added.push(k);
            else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
          }
          for (const k of Object.keys(a)) {
            if (!(k in b)) removed.push(k);
          }
          return { content: JSON.stringify({ added, removed, changed }) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `json.diff error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.range',
      description: 'Generate numeric range. Input: "<start>::<end>" or "<start>::<end>::<step>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::').map((p) => p.trim());
        if (parts.length < 2 || parts.length > 3) return { content: 'array.range: needs <start>::<end>[::<step>]', error: true };
        const start = Number(parts[0]);
        const end = Number(parts[1]);
        const step = parts[2] !== undefined ? Number(parts[2]) : 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step === 0) {
          return { content: 'array.range: invalid numeric input', error: true };
        }
        const out: number[] = [];
        if (step > 0) { for (let i = start; i < end; i += step) { out.push(i); if (out.length > 100_000) break; } }
        else { for (let i = start; i > end; i += step) { out.push(i); if (out.length > 100_000) break; } }
        return { content: JSON.stringify(out) };
      }
    },
    {
      name: 'array.intersect',
      description: 'Intersection of two JSON arrays (type-aware, preserves order from left). Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'array.intersect: needs <a>::<b>', error: true };
        try {
          const a = JSON.parse(input.slice(0, sep));
          const b = JSON.parse(input.slice(sep + 2));
          if (!Array.isArray(a) || !Array.isArray(b)) return { content: 'array.intersect: both must be arrays', error: true };
          // Type-aware key: include type prefix to avoid 1 vs "1" collision.
          const keyOf = (x: unknown) => `${typeof x}:${typeof x === 'object' ? JSON.stringify(x) : String(x)}`;
          const bSet = new Set(b.map(keyOf));
          const out = a.filter((x) => bSet.has(keyOf(x)));
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.intersect error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.diff',
      description: 'Items in left not in right (type-aware). Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'array.diff: needs <a>::<b>', error: true };
        try {
          const a = JSON.parse(input.slice(0, sep));
          const b = JSON.parse(input.slice(sep + 2));
          if (!Array.isArray(a) || !Array.isArray(b)) return { content: 'array.diff: both must be arrays', error: true };
          const keyOf = (x: unknown) => `${typeof x}:${typeof x === 'object' ? JSON.stringify(x) : String(x)}`;
          const bSet = new Set(b.map(keyOf));
          const out = a.filter((x) => !bSet.has(keyOf(x)));
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.diff error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.padLeft',
      description: 'Pad string on left. Input: "<text>::<width>::<pad>" — pad supports multi-char patterns.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::');
        if (parts.length < 2) return { content: 'text.padLeft: needs <text>::<width>[::<pad>]', error: true };
        const text = parts[0]!;
        const width = parseInt(parts[1]!, 10);
        const pad = parts[2] !== undefined && parts[2] !== '' ? parts[2] : ' ';
        if (!Number.isFinite(width) || width < 0 || width > 10_000) return { content: 'text.padLeft: invalid width', error: true };
        return { content: text.padStart(width, pad) };
      }
    },
    {
      name: 'text.padRight',
      description: 'Pad string on right. Input: "<text>::<width>::<pad>" — pad supports multi-char patterns.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::');
        if (parts.length < 2) return { content: 'text.padRight: needs <text>::<width>[::<pad>]', error: true };
        const text = parts[0]!;
        const width = parseInt(parts[1]!, 10);
        const pad = parts[2] !== undefined && parts[2] !== '' ? parts[2] : ' ';
        if (!Number.isFinite(width) || width < 0 || width > 10_000) return { content: 'text.padRight: invalid width', error: true };
        return { content: text.padEnd(width, pad) };
      }
    },
    {
      name: 'text.indent',
      description: 'Indent every non-empty line. Input: "<text>::<n-spaces>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        if (sep === -1) return { content: 'text.indent: needs <text>::<n>', error: true };
        const tail = input.slice(sep + 2).trim();
        const n = parseInt(tail, 10);
        if (!/^\d+$/.test(tail) || n < 0 || n > 64) return { content: 'text.indent: invalid n (0-64)', error: true };
        const pad = ' '.repeat(n);
        return { content: input.slice(0, sep).split(/\n/).map((l) => l ? pad + l : l).join('\n') };
      }
    },
    {
      name: 'math.round',
      description: 'Round number to N decimals. Input: "<num>" or "<num>::<decimals>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        const numStr = sep === -1 ? input : input.slice(0, sep);
        const decStr = sep === -1 ? '0' : input.slice(sep + 2).trim();
        const num = Number(numStr);
        const decimals = parseInt(decStr, 10);
        if (!Number.isFinite(num)) return { content: 'math.round: invalid number', error: true };
        if (!Number.isFinite(decimals) || decimals < 0 || decimals > 20) return { content: 'math.round: invalid decimals', error: true };
        const factor = 10 ** decimals;
        return { content: String(Math.round(num * factor) / factor) };
      }
    },
    {
      name: 'math.clamp',
      description: 'Clamp value between min and max. Input: "<value>::<min>::<max>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::').map((p) => Number(p.trim()));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
          return { content: 'math.clamp: needs <value>::<min>::<max>', error: true };
        }
        const [v, lo, hi] = parts as [number, number, number];
        if (lo > hi) return { content: 'math.clamp: min > max', error: true };
        return { content: String(Math.max(lo, Math.min(hi, v))) };
      }
    },
    {
      name: 'geo.distance',
      description: 'Haversine distance in km. Input: "<lat1>,<lon1>::<lat2>,<lon2>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'geo.distance: needs <lat,lon>::<lat,lon>', error: true };
        const a = input.slice(0, sep).split(',').map(Number);
        const b = input.slice(sep + 2).split(',').map(Number);
        if (a.length !== 2 || b.length !== 2 || [...a, ...b].some((n) => !Number.isFinite(n))) {
          return { content: 'geo.distance: invalid coordinates', error: true };
        }
        const R = 6371; // km
        const toRad = (d: number) => d * Math.PI / 180;
        const dLat = toRad(b[0]! - a[0]!);
        const dLon = toRad(b[1]! - a[1]!);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0]!)) * Math.cos(toRad(b[0]!)) * Math.sin(dLon / 2) ** 2;
        const km = 2 * R * Math.asin(Math.sqrt(h));
        return { content: String(Math.round(km * 1000) / 1000) };
      }
    },
    {
      name: 'crypto.randomString',
      description: 'Generate cryptographically secure random alphanumeric string of length N (1-512).',
      tags: ['read', 'safe'],
      execute: (input) => {
        const n = parseInt(input.trim(), 10);
        if (!Number.isFinite(n) || n < 1 || n > 512) return { content: 'crypto.randomString: invalid length (1-512)', error: true };
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = randomBytes(n);
        let out = '';
        for (let i = 0; i < n; i++) out += alphabet[bytes[i]! % alphabet.length];
        return { content: out };
      }
    },
    {
      name: 'validate.email',
      description: 'Validate email syntax (RFC-5322 lite). Returns "true" / "false".',
      tags: ['read', 'safe'],
      execute: (input) => {
        // Stricter: requires alpha local part, valid domain labels, TLD >= 2 alpha.
        const re = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
        return { content: String(re.test(input.trim())) };
      }
    },
    {
      name: 'validate.url',
      description: 'Validate URL syntax. Returns "true" / "false".',
      tags: ['read', 'safe'],
      execute: (input) => {
        try { new URL(input.trim()); return { content: 'true' }; }
        catch { return { content: 'false' }; }
      }
    },
    {
      name: 'validate.ipv4',
      description: 'Validate IPv4 address syntax. Returns "true" / "false".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.trim().split('.');
        if (parts.length !== 4) return { content: 'false' };
        for (const p of parts) {
          if (!/^\d+$/.test(p)) return { content: 'false' };
          const n = parseInt(p, 10);
          if (n < 0 || n > 255) return { content: 'false' };
        }
        return { content: 'true' };
      }
    },
    {
      name: 'array.shuffle',
      description: 'Fisher-Yates shuffle of a JSON array using crypto-secure randomness.',
      tags: ['read', 'safe'],
      execute: (input) => {
        try {
          const arr = JSON.parse(input);
          if (!Array.isArray(arr)) return { content: 'array.shuffle: not an array', error: true };
          if (arr.length < 2) return { content: JSON.stringify(arr) };
          const out = [...arr];
          for (let i = out.length - 1; i > 0; i--) {
            const j = randomInt(0, i + 1);
            const tmp = out[i];
            out[i] = out[j] as unknown;
            out[j] = tmp as unknown;
          }
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.shuffle error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.groupBy',
      description: 'Group items by a JSON path key. Input: "<json-array>::<path>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        if (sep === -1) return { content: 'array.groupBy: needs <json-array>::<path>', error: true };
        try {
          const arr = JSON.parse(input.slice(0, sep));
          const path = input.slice(sep + 2).trim();
          if (!Array.isArray(arr)) return { content: 'array.groupBy: not an array', error: true };
          const groups: Record<string, unknown[]> = {};
          for (const item of arr) {
            let v: unknown = item;
            for (const part of path.split('.')) {
              if (v && typeof v === 'object' && part in (v as Record<string, unknown>)) {
                v = (v as Record<string, unknown>)[part];
              } else { v = undefined; break; }
            }
            const key = v === undefined || v === null ? '_null' : String(v);
            (groups[key] ??= []).push(item);
          }
          return { content: JSON.stringify(groups) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.groupBy error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.title',
      description: 'Title-case text (capitalize first letter of each word).',
      tags: ['read', 'safe'],
      execute: (input) => ({
        content: input.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
      })
    },
    {
      name: 'text.camel',
      description: 'Convert text to camelCase.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.trim().split(/[\s_\-]+/).filter(Boolean);
        if (parts.length === 0) return { content: '' };
        const out = parts[0]!.toLowerCase()
          + parts.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
        return { content: out };
      }
    },
    {
      name: 'text.snake',
      description: 'Convert text to snake_case.',
      tags: ['read', 'safe'],
      execute: (input) => ({
        content: input.trim()
          .replace(/([a-z])([A-Z])/g, '$1_$2')
          .replace(/[\s\-]+/g, '_')
          .toLowerCase()
      })
    },
    {
      name: 'text.kebab',
      description: 'Convert text to kebab-case.',
      tags: ['read', 'safe'],
      execute: (input) => ({
        content: input.trim()
          .replace(/([a-z])([A-Z])/g, '$1-$2')
          .replace(/[\s_]+/g, '-')
          .toLowerCase()
      })
    },
    {
      name: 'math.factorial',
      description: 'Compute factorial n! for 0 <= n <= 170 (returns Infinity beyond).',
      tags: ['read', 'safe'],
      execute: (input) => {
        const n = parseInt(input.trim(), 10);
        if (!Number.isFinite(n) || n < 0 || n > 1000) return { content: 'math.factorial: invalid n (0-1000)', error: true };
        let result = 1;
        for (let i = 2; i <= n; i++) result *= i;
        return { content: String(result) };
      }
    },
    {
      name: 'math.fibonacci',
      description: 'N-th Fibonacci number (0-indexed). Supports n up to 1476.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const n = parseInt(input.trim(), 10);
        if (!Number.isFinite(n) || n < 0 || n > 1476) return { content: 'math.fibonacci: invalid n (0-1476)', error: true };
        if (n < 2) return { content: String(n) };
        let a = 0, b = 1;
        for (let i = 2; i <= n; i++) { const t = a + b; a = b; b = t; }
        return { content: String(b) };
      }
    },
    {
      name: 'math.isPrime',
      description: 'Check whether N is prime. Returns "true" / "false".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const n = parseInt(input.trim(), 10);
        if (!Number.isFinite(n)) return { content: 'math.isPrime: invalid input', error: true };
        if (n < 2) return { content: 'false' };
        if (n < 4) return { content: 'true' };
        if (n % 2 === 0) return { content: 'false' };
        const limit = Math.floor(Math.sqrt(n));
        for (let i = 3; i <= limit; i += 2) if (n % i === 0) return { content: 'false' };
        return { content: 'true' };
      }
    },
    // ===== OpenClaw-inspired v2.0 tools =====
    {
      name: 'longterm.read',
      description: 'Read the long-term MEMORY.md file (durable cross-session facts).',
      tags: ['read', 'memory', 'longterm'],
      execute: async () => {
        if (!deps.longterm) return { content: 'longterm.read: not configured', error: true };
        const body = await deps.longterm.read();
        return { content: body || '(empty)' };
      }
    },
    {
      name: 'longterm.append',
      description: 'Append a fact to MEMORY.md. Input: "<section>::<fact>".',
      tags: ['write', 'memory', 'longterm'],
      execute: async (input) => {
        if (!deps.longterm) return { content: 'longterm.append: not configured', error: true };
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'longterm.append: needs <section>::<fact>', error: true };
        const block = await deps.longterm.append(input.slice(0, sep).trim() || 'general', input.slice(sep + 2));
        return { content: `appended:${block.split("\n")[2] ?? ""}` };
      }
    },
    {
      name: 'longterm.search',
      description: 'Search long-term memory by substring. Input: "<query>" or "<query>::<limit>".',
      tags: ['read', 'memory', 'longterm'],
      execute: async (input) => {
        if (!deps.longterm) return { content: 'longterm.search: not configured', error: true };
        const sep = input.lastIndexOf('::');
        const q = sep === -1 ? input : input.slice(0, sep);
        const limit = sep === -1 ? 10 : Math.min(50, parseInt(input.slice(sep + 2), 10) || 10);
        const hits = await deps.longterm.search(q.trim(), limit);
        return { content: JSON.stringify(hits) };
      }
    },
    {
      name: 'daily.log',
      description: 'Read daily log for a date. Input: "YYYY-MM-DD" (or empty for today).',
      tags: ['read', 'memory', 'log'],
      execute: async (input) => {
        if (!deps.dailyLog) return { content: 'daily.log: not configured', error: true };
        const date = input.trim() || new Date().toISOString().slice(0, 10);
        const body = await deps.dailyLog.read(date);
        return { content: body || `(no entries for ${date})` };
      }
    },
    {
      name: 'daily.dates',
      description: 'List available daily-log dates (newest first).',
      tags: ['read', 'memory', 'log'],
      execute: async () => {
        if (!deps.dailyLog) return { content: 'daily.dates: not configured', error: true };
        return { content: JSON.stringify(await deps.dailyLog.listDates()) };
      }
    },
    {
      name: 'agent.spawn',
      description: 'Spawn a background sub-agent for a task. Returns the job id (sub-agents cannot nest).',
      tags: ['write', 'subagent'],
      execute: (input, ctx) => {
        if (!deps.subagent) return { content: 'agent.spawn: not configured', error: true };
        if (!input.trim()) return { content: 'agent.spawn: empty task', error: true };
        const r = deps.subagent.spawn(input.trim(), ctx.session);
        if (!r.accepted) return { content: `agent.spawn rejected: ${r.reason}`, error: true };
        return { content: `jobId:${r.jobId}` };
      }
    },
    {
      name: 'agent.status',
      description: 'Query the status of a sub-agent job by id.',
      tags: ['read', 'subagent'],
      execute: (input) => {
        if (!deps.subagent) return { content: 'agent.status: not configured', error: true };
        const job = deps.subagent.get(input.trim());
        if (!job) return { content: 'agent.status: job not found', error: true };
        return { content: JSON.stringify(job) };
      }
    },
    {
      name: 'agent.list',
      description: 'List sub-agent jobs (newest first).',
      tags: ['read', 'subagent'],
      execute: () => {
        if (!deps.subagent) return { content: 'agent.list: not configured', error: true };
        return { content: JSON.stringify(deps.subagent.list().slice(0, 20)) };
      }
    },
    {
      name: 'node.list',
      description: 'List paired device nodes with their capabilities.',
      tags: ['read', 'node'],
      execute: () => {
        if (!deps.nodes) return { content: 'node.list: not configured', error: true };
        return { content: JSON.stringify(deps.nodes.list()) };
      }
    },
    {
      name: 'node.invoke',
      description: 'Invoke a capability on a paired device node. Input: "<nodeId>::<capability>::<json-input>".',
      tags: ['write', 'node'],
      execute: async (input) => {
        if (!deps.nodes) return { content: 'node.invoke: not configured', error: true };
        const parts = input.split('::');
        if (parts.length < 2) return { content: 'node.invoke: needs <nodeId>::<capability>[::<json>]', error: true };
        const [nodeId, capability, ...rest] = parts;
        const argRaw = rest.join('::');
        let arg: unknown = {};
        if (argRaw) { try { arg = JSON.parse(argRaw); } catch { arg = argRaw; } }
        const node = deps.nodes.get(nodeId!);
        if (!node) return { content: `node.invoke: unknown node ${nodeId}`, error: true };
        if (!node.capabilities.includes(capability!)) {
          return { content: `node.invoke: node ${nodeId} does not advertise ${capability}`, error: true };
        }
        const inv = deps.nodes.invoke(nodeId!, capability!, arg);
        try {
          const settled = await deps.nodes.wait(inv.id, 5_000);
          return { content: JSON.stringify(settled) };
        } catch {
          return { content: `invocationId:${inv.id} (pending)` };
        }
      }
    },
    {
      name: 'skills.list',
      description: 'List loaded skills (metadata only — OpenClaw-style lazy loading).',
      tags: ['read', 'skill'],
      execute: () => {
        if (!deps.skillsLoader) return { content: 'skills.list: not configured', error: true };
        return { content: JSON.stringify(deps.skillsLoader.list()) };
      }
    },
    {
      name: 'skills.read',
      description: 'Read full skill content by name. Use this only when you intend to apply the skill.',
      tags: ['read', 'skill'],
      execute: (input) => {
        if (!deps.skillsLoader) return { content: 'skills.read: not configured', error: true };
        const body = deps.skillsLoader.read(input.trim());
        return body ? { content: body } : { content: `skills.read: skill "${input.trim()}" not found`, error: true };
      }
    },
    // ===== v2.1 additions =====
    {
      name: 'longterm.section',
      description: 'Read a single section from MEMORY.md by name.',
      tags: ['read', 'memory', 'longterm'],
      execute: async (input) => {
        if (!deps.longterm) return { content: 'longterm.section: not configured', error: true };
        const body = await deps.longterm.section(input.trim());
        return { content: body || `(no section "${input.trim()}")` };
      }
    },
    {
      name: 'longterm.clear',
      description: 'Erase all long-term memory. Returns the number of bytes removed.',
      tags: ['write', 'memory', 'longterm', 'destructive'],
      execute: async () => {
        if (!deps.longterm) return { content: 'longterm.clear: not configured', error: true };
        const bytes = await deps.longterm.clear();
        return { content: `cleared ${bytes} bytes` };
      }
    },
    {
      name: 'longterm.stats',
      description: 'Return long-term memory stats: { bytes, facts }.',
      tags: ['read', 'memory', 'longterm'],
      execute: async () => {
        if (!deps.longterm) return { content: 'longterm.stats: not configured', error: true };
        const facts = await deps.longterm.factCount();
        return { content: JSON.stringify({ bytes: deps.longterm.size(), facts }) };
      }
    },
    {
      name: 'agent.wait',
      description: 'Wait for a sub-agent job to settle. Input: "<jobId>" or "<jobId>::<timeoutMs>".',
      tags: ['read', 'subagent'],
      execute: async (input) => {
        if (!deps.subagent) return { content: 'agent.wait: not configured', error: true };
        const sep = input.indexOf('::');
        const jobId = (sep === -1 ? input : input.slice(0, sep)).trim();
        const timeoutMs = sep === -1 ? 30_000 : Math.max(1, parseInt(input.slice(sep + 2), 10) || 30_000);
        try {
          const job = await deps.subagent.wait(jobId, timeoutMs);
          return { content: JSON.stringify(job) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `agent.wait: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'agent.cancel',
      description: 'Best-effort cancel of a pending sub-agent job.',
      tags: ['write', 'subagent'],
      execute: (input) => {
        if (!deps.subagent) return { content: 'agent.cancel: not configured', error: true };
        const ok = deps.subagent.cancel(input.trim());
        return { content: ok ? 'cancelled' : 'not-cancellable' };
      }
    },
    {
      name: 'node.register',
      description: 'Register a virtual device node. Input: JSON {name, platform, capabilities[]}.',
      tags: ['write', 'node'],
      execute: (input) => {
        if (!deps.nodes) return { content: 'node.register: not configured', error: true };
        try {
          const obj = JSON.parse(input);
          if (!obj.name || !obj.platform || !Array.isArray(obj.capabilities)) {
            return { content: 'node.register: needs {name, platform, capabilities[]}', error: true };
          }
          const node = deps.nodes.register(obj);
          return { content: JSON.stringify(node) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `node.register error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'node.unregister',
      description: 'Unregister a paired device node by id.',
      tags: ['write', 'node'],
      execute: (input) => {
        if (!deps.nodes) return { content: 'node.unregister: not configured', error: true };
        return { content: deps.nodes.unregister(input.trim()) ? 'removed' : 'not-found' };
      }
    },
    // ===== v2.2 additions =====
    {
      name: 'longterm.sections',
      description: 'List all section names in MEMORY.md (preserves file order).',
      tags: ['read', 'memory', 'longterm'],
      execute: async () => {
        if (!deps.longterm) return { content: 'longterm.sections: not configured', error: true };
        return { content: JSON.stringify(await deps.longterm.sections()) };
      }
    },
    {
      name: 'agent.stats',
      description: 'Sub-agent job counters by status.',
      tags: ['read', 'subagent'],
      execute: () => {
        if (!deps.subagent) return { content: 'agent.stats: not configured', error: true };
        return { content: JSON.stringify(deps.subagent.stats()) };
      }
    },
    {
      name: 'agent.prune',
      description: 'Drop completed sub-agent jobs older than N ms (default 3600000 = 1h).',
      tags: ['write', 'subagent'],
      execute: (input) => {
        if (!deps.subagent) return { content: 'agent.prune: not configured', error: true };
        const ms = input.trim() ? parseInt(input.trim(), 10) : 3_600_000;
        if (!Number.isFinite(ms) || ms < 0) return { content: 'agent.prune: invalid ms', error: true };
        return { content: `pruned ${deps.subagent.prune(ms)} jobs` };
      }
    },
    {
      name: 'node.stats',
      description: 'Node + invocation counters.',
      tags: ['read', 'node'],
      execute: () => {
        if (!deps.nodes) return { content: 'node.stats: not configured', error: true };
        return { content: JSON.stringify(deps.nodes.stats()) };
      }
    },
    {
      name: 'node.invocations',
      description: 'Recent node invocations (newest first). Input: optional limit (default 20).',
      tags: ['read', 'node'],
      execute: (input) => {
        if (!deps.nodes) return { content: 'node.invocations: not configured', error: true };
        const limit = input.trim() ? Math.min(200, parseInt(input.trim(), 10) || 20) : 20;
        return { content: JSON.stringify(deps.nodes.listInvocations().slice(0, limit)) };
      }
    },
    {
      name: 'node.idle',
      description: 'Nodes not seen in the last N ms. Input: "<ms>" (default 60000).',
      tags: ['read', 'node'],
      execute: (input) => {
        if (!deps.nodes) return { content: 'node.idle: not configured', error: true };
        const trimmed = input.trim();
        const ms = trimmed === '' ? 60_000 : parseInt(trimmed, 10);
        if (!Number.isFinite(ms) || ms < 0) return { content: 'node.idle: invalid ms', error: true };
        return { content: JSON.stringify(deps.nodes.idle(ms)) };
      }
    },
    // ===== v2.3 additions =====
    {
      name: 'longterm.history',
      description: 'Chronological fact list across all sections (newest first). Input: optional limit (default 50).',
      tags: ['read', 'memory', 'longterm'],
      execute: async (input) => {
        if (!deps.longterm) return { content: 'longterm.history: not configured', error: true };
        const trimmed = input.trim();
        const limit = trimmed === '' ? 50 : parseInt(trimmed, 10);
        if (!Number.isFinite(limit) || limit < 1) return { content: 'longterm.history: invalid limit', error: true };
        return { content: JSON.stringify(await deps.longterm.history(limit)) };
      }
    },
    {
      name: 'agent.active',
      description: 'List currently running or pending sub-agent jobs.',
      tags: ['read', 'subagent'],
      execute: () => {
        if (!deps.subagent) return { content: 'agent.active: not configured', error: true };
        return { content: JSON.stringify(deps.subagent.active()) };
      }
    },
    {
      name: 'agent.duration',
      description: 'Runtime in ms for a sub-agent job by id.',
      tags: ['read', 'subagent'],
      execute: (input) => {
        if (!deps.subagent) return { content: 'agent.duration: not configured', error: true };
        const id = input.trim();
        if (!id) return { content: 'agent.duration: empty id', error: true };
        return { content: String(deps.subagent.jobDuration(id)) };
      }
    },
    {
      name: 'node.byCapability',
      description: 'List device nodes that advertise a given capability.',
      tags: ['read', 'node'],
      execute: (input) => {
        if (!deps.nodes) return { content: 'node.byCapability: not configured', error: true };
        const cap = input.trim();
        if (!cap) return { content: 'node.byCapability: empty capability', error: true };
        return { content: JSON.stringify(deps.nodes.byCapability(cap)) };
      }
    },
    // ===== v2.4 additions =====
    {
      name: 'longterm.byDate',
      description: 'Return MEMORY.md facts logged on a specific date (YYYY-MM-DD).',
      tags: ['read', 'memory', 'longterm'],
      execute: async (input) => {
        if (!deps.longterm) return { content: 'longterm.byDate: not configured', error: true };
        const date = input.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { content: 'longterm.byDate: invalid date (YYYY-MM-DD)', error: true };
        return { content: JSON.stringify(await deps.longterm.byDate(date)) };
      }
    },
    {
      name: 'daily.summary',
      description: 'Summary stats for the daily log directory: { dates, bytes }.',
      tags: ['read', 'memory', 'log'],
      execute: async () => {
        if (!deps.dailyLog) return { content: 'daily.summary: not configured', error: true };
        return { content: JSON.stringify(await deps.dailyLog.summary()) };
      }
    },
    {
      name: 'hooks.byEvent',
      description: 'List hooks registered for a specific event name.',
      tags: ['read', 'hooks'],
      execute: (input) => {
        if (!deps.hooks) return { content: 'hooks.byEvent: not configured', error: true };
        const event = input.trim();
        if (!event) return { content: 'hooks.byEvent: empty event', error: true };
        return { content: JSON.stringify(deps.hooks.byEvent(event)) };
      }
    },
    {
      name: 'hooks.size',
      description: 'Total number of registered hooks across all events.',
      tags: ['read', 'hooks'],
      execute: () => {
        if (!deps.hooks) return { content: 'hooks.size: not configured', error: true };
        return { content: String(deps.hooks.size()) };
      }
    },
    // ===== v2.5 additions =====
    {
      name: 'daily.latest',
      description: 'Combined markdown of the last N daily logs (newest first). Input: optional N (default 3).',
      tags: ['read', 'memory', 'log'],
      execute: async (input) => {
        if (!deps.dailyLog) return { content: 'daily.latest: not configured', error: true };
        const trimmed = input.trim();
        const n = trimmed === '' ? 3 : parseInt(trimmed, 10);
        if (!Number.isFinite(n) || n < 1) return { content: 'daily.latest: invalid N', error: true };
        const body = await deps.dailyLog.latest(n);
        return { content: body || '(no daily logs yet)' };
      }
    },
    {
      name: 'longterm.replace',
      description: 'Replace the entire MEMORY.md body. Input: full markdown text.',
      tags: ['write', 'memory', 'longterm', 'destructive'],
      execute: async (input) => {
        if (!deps.longterm) return { content: 'longterm.replace: not configured', error: true };
        await deps.longterm.replace(input);
        return { content: `replaced; new size ${deps.longterm.size()} bytes` };
      }
    },
    {
      name: 'agent.pending',
      description: 'Number of sub-agent jobs in pending or running state.',
      tags: ['read', 'subagent'],
      execute: () => {
        if (!deps.subagent) return { content: 'agent.pending: not configured', error: true };
        return { content: String(deps.subagent.pending()) };
      }
    },
    // ===== v2.6 additions =====
    {
      name: 'skills.match',
      description: 'Find loaded skills with token overlap to input text. Input: text or empty.',
      tags: ['read', 'skill'],
      execute: (input) => {
        if (!deps.skillsLoader) return { content: 'skills.match: not configured', error: true };
        const text = input.trim().toLowerCase();
        if (!text) return { content: JSON.stringify(deps.skillsLoader.list()) };
        const tokens = new Set(text.split(/\s+/).filter((t) => t.length > 2));
        const scored = deps.skillsLoader.list().map((s) => {
          const hay = (s.name + ' ' + s.description).toLowerCase();
          let score = 0;
          for (const t of tokens) if (hay.includes(t)) score += 1;
          return { ...s, score };
        }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
        return { content: JSON.stringify(scored) };
      }
    },
    {
      name: 'audit.kinds',
      description: 'Distinct audit kinds present in the in-memory audit log.',
      tags: ['read', 'audit'],
      execute: () => {
        const sink = deps.auditSink;
        if (!sink) return { content: 'audit.kinds: not configured', error: true };
        const kinds = new Set<string>();
        for (const entry of sink.list({ limit: 10_000 })) kinds.add(entry.kind);
        return { content: JSON.stringify([...kinds].sort()) };
      }
    },
    {
      name: 'audit.count',
      description: 'Counters by audit kind across the in-memory audit log.',
      tags: ['read', 'audit'],
      execute: () => {
        const sink = deps.auditSink;
        if (!sink) return { content: 'audit.count: not configured', error: true };
        const counts: Record<string, number> = {};
        for (const entry of sink.list({ limit: 10_000 })) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
        return { content: JSON.stringify(counts) };
      }
    },
    {
      name: 'compactor.plan',
      description: 'Dry-run context compaction on a JSON array of turns: [{role,content,importance?}].',
      tags: ['read', 'compaction'],
      execute: (input) => {
        if (!deps.compactor) return { content: 'compactor.plan: not configured', error: true };
        try {
          const turns = JSON.parse(input);
          if (!Array.isArray(turns)) return { content: 'compactor.plan: not an array', error: true };
          return { content: JSON.stringify(deps.compactor.plan(turns)) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `compactor.plan error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'soul.read',
      description: 'Read the agent SOUL.md file (personality, voice, boundaries).',
      tags: ['read', 'workspace'],
      execute: async () => {
        if (!deps.workspace) return { content: 'soul.read: not configured', error: true };
        return { content: await deps.workspace.readSoul() };
      }
    },
    {
      name: 'soul.write',
      description: 'Replace the agent SOUL.md (max 256 KiB).',
      tags: ['write', 'workspace'],
      execute: async (input) => {
        if (!deps.workspace) return { content: 'soul.write: not configured', error: true };
        try { await deps.workspace.writeSoul(input); return { content: 'ok' }; }
        catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `soul.write error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'user.read',
      description: 'Read USER.md for a given userId.',
      tags: ['read', 'workspace'],
      execute: async (input) => {
        if (!deps.workspace) return { content: 'user.read: not configured', error: true };
        const userId = input.trim();
        if (!userId) return { content: 'user.read: empty userId', error: true };
        return { content: await deps.workspace.readUser(userId) };
      }
    },
    {
      name: 'user.write',
      description: 'Write USER.md for a userId. Input: "<userId>::<markdown body>".',
      tags: ['write', 'workspace'],
      execute: async (input) => {
        if (!deps.workspace) return { content: 'user.write: not configured', error: true };
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'user.write: needs <userId>::<body>', error: true };
        try {
          await deps.workspace.writeUser(input.slice(0, sep), input.slice(sep + 2));
          return { content: 'ok' };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `user.write error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'agents.read',
      description: 'Read the AGENTS.md roster.',
      tags: ['read', 'workspace'],
      execute: async () => {
        if (!deps.workspace) return { content: 'agents.read: not configured', error: true };
        return { content: await deps.workspace.readAgents() };
      }
    },
    {
      name: 'heartbeat.status',
      description: 'Get the latest heartbeat sample (uptime, memory, pending sub-agents).',
      tags: ['read', 'heartbeat'],
      execute: () => {
        if (!deps.heartbeat) return { content: 'heartbeat.status: not configured', error: true };
        const latest = deps.heartbeat.latest();
        return { content: JSON.stringify({
          running: deps.heartbeat.isRunning(),
          samples: deps.heartbeat.count(),
          latest
        }) };
      }
    },
    {
      name: 'heartbeat.beat',
      description: 'Force an immediate heartbeat sample. Returns the new sample.',
      tags: ['write', 'heartbeat'],
      execute: async () => {
        if (!deps.heartbeat) return { content: 'heartbeat.beat: not configured', error: true };
        return { content: JSON.stringify(await deps.heartbeat.beat()) };
      }
    },
    {
      name: 'compactor.size',
      description: 'Return character size of a JSON turn array (compactor budget metric).',
      tags: ['read', 'compaction'],
      execute: (input) => {
        if (!deps.compactor) return { content: 'compactor.size: not configured', error: true };
        try {
          const turns = JSON.parse(input);
          if (!Array.isArray(turns)) return { content: 'compactor.size: not an array', error: true };
          return { content: String(deps.compactor.size(turns)) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `compactor.size error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.head',
      description: 'First N items of a JSON array. Input: "<json>::<n>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        if (sep === -1) return { content: 'array.head: needs <json>::<n>', error: true };
        const tail = input.slice(sep + 2).trim();
        const n = parseInt(tail, 10);
        if (!/^\d+$/.test(tail) || n < 0) return { content: 'array.head: invalid n', error: true };
        try {
          const arr = JSON.parse(input.slice(0, sep));
          if (!Array.isArray(arr)) return { content: 'array.head: not an array', error: true };
          return { content: JSON.stringify(arr.slice(0, n)) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.head error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.tail',
      description: 'Last N items of a JSON array. Input: "<json>::<n>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        if (sep === -1) return { content: 'array.tail: needs <json>::<n>', error: true };
        const tail = input.slice(sep + 2).trim();
        const n = parseInt(tail, 10);
        if (!/^\d+$/.test(tail) || n < 0) return { content: 'array.tail: invalid n', error: true };
        try {
          const arr = JSON.parse(input.slice(0, sep));
          if (!Array.isArray(arr)) return { content: 'array.tail: not an array', error: true };
          return { content: JSON.stringify(arr.slice(-n)) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.tail error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.split',
      description: 'Split text by separator. Input: "<text>::<sep>". Returns JSON array.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'text.split: needs <text>::<sep>', error: true };
        const text = input.slice(0, sep);
        const separator = input.slice(sep + 2);
        if (separator === '') return { content: JSON.stringify([...text]) };
        return { content: JSON.stringify(text.split(separator)) };
      }
    },
    {
      name: 'text.join',
      description: 'Join JSON array with separator. Input: "<json>::<sep>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'text.join: needs <json>::<sep>', error: true };
        try {
          const arr = JSON.parse(input.slice(0, sep));
          if (!Array.isArray(arr)) return { content: 'text.join: not an array', error: true };
          return { content: arr.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(input.slice(sep + 2)) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `text.join error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.between',
      description: 'Extract substring between two markers. Input: "<text>::<start>::<end>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::');
        if (parts.length < 3) return { content: 'text.between: needs <text>::<start>::<end>', error: true };
        // Re-join when text contains ::
        const end = parts[parts.length - 1]!;
        const start = parts[parts.length - 2]!;
        const text = parts.slice(0, -2).join('::');
        const i = text.indexOf(start);
        if (i === -1) return { content: '' };
        const j = text.indexOf(end, i + start.length);
        if (j === -1) return { content: '' };
        return { content: text.slice(i + start.length, j) };
      }
    },
    {
      name: 'text.replaceAll',
      description: 'Global string replace (literal). Input: "<text>::<find>::<replace>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::');
        if (parts.length < 3) return { content: 'text.replaceAll: needs <text>::<find>::<replace>', error: true };
        const replace = parts[parts.length - 1]!;
        const find = parts[parts.length - 2]!;
        const text = parts.slice(0, -2).join('::');
        if (find === '') return { content: text };
        return { content: text.split(find).join(replace) };
      }
    },
    {
      name: 'text.escapeHtml',
      description: 'Escape HTML special chars (&, <, >, ", \').',
      tags: ['read', 'safe'],
      execute: (input) => {
        const escaped = input
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
        return { content: escaped };
      }
    },
    {
      name: 'text.unescapeHtml',
      description: 'Unescape HTML entities (&amp; &lt; &gt; &quot; &#39; &apos;).',
      tags: ['read', 'safe'],
      execute: (input) => {
        const out = input
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&');
        return { content: out };
      }
    },
    {
      name: 'math.percentile',
      description: 'N-th percentile (0-100) of a numeric JSON array. Input: "<json>::<p>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.lastIndexOf('::');
        if (sep === -1) return { content: 'math.percentile: needs <json>::<p>', error: true };
        const p = Number(input.slice(sep + 2));
        if (!Number.isFinite(p) || p < 0 || p > 100) return { content: 'math.percentile: p must be 0-100', error: true };
        try {
          const arr = JSON.parse(input.slice(0, sep));
          if (!Array.isArray(arr) || arr.length === 0) return { content: 'math.percentile: empty or non-array', error: true };
          const nums = arr.map(Number);
          if (nums.some((n) => !Number.isFinite(n))) return { content: 'math.percentile: non-numeric', error: true };
          const sorted = [...nums].sort((a, b) => a - b);
          if (sorted.length === 1) return { content: String(sorted[0]) };
          const rank = (p / 100) * (sorted.length - 1);
          const lo = Math.floor(rank);
          const hi = Math.ceil(rank);
          if (lo === hi) return { content: String(sorted[lo]) };
          const value = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
          return { content: String(value) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `math.percentile error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'math.gcd',
      description: 'Greatest common divisor of two integers. Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'math.gcd: needs <a>::<b>', error: true };
        const a = parseInt(input.slice(0, sep).trim(), 10);
        const b = parseInt(input.slice(sep + 2).trim(), 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return { content: 'math.gcd: invalid integers', error: true };
        let x = Math.abs(a), y = Math.abs(b);
        while (y !== 0) { [x, y] = [y, x % y]; }
        return { content: String(x) };
      }
    },
    {
      name: 'math.lcm',
      description: 'Least common multiple of two integers. Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'math.lcm: needs <a>::<b>', error: true };
        const a = parseInt(input.slice(0, sep).trim(), 10);
        const b = parseInt(input.slice(sep + 2).trim(), 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return { content: 'math.lcm: invalid integers', error: true };
        if (a === 0 || b === 0) return { content: '0' };
        let x = Math.abs(a), y = Math.abs(b);
        const product = x * y;
        while (y !== 0) { [x, y] = [y, x % y]; }
        return { content: String(product / x) };
      }
    },
    {
      name: 'uuid.validate',
      description: 'Validate UUID v4 syntax. Returns "true" / "false".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        return { content: String(re.test(input.trim())) };
      }
    },
    {
      name: 'color.parse',
      description: 'Parse hex color (#RGB or #RRGGBB) into {r,g,b,hex,rgba}.',
      tags: ['read', 'safe'],
      execute: (input) => {
        const hex = input.trim().replace(/^#/, '');
        let r: number, g: number, b: number;
        if (/^[0-9a-fA-F]{3}$/.test(hex)) {
          r = parseInt(hex[0]! + hex[0]!, 16);
          g = parseInt(hex[1]! + hex[1]!, 16);
          b = parseInt(hex[2]! + hex[2]!, 16);
        } else if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          r = parseInt(hex.slice(0, 2), 16);
          g = parseInt(hex.slice(2, 4), 16);
          b = parseInt(hex.slice(4, 6), 16);
        } else {
          return { content: 'color.parse: invalid hex color', error: true };
        }
        const fullHex = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
        return { content: JSON.stringify({ r, g, b, hex: fullHex, rgba: `rgba(${r},${g},${b},1)` }) };
      }
    },
    // ===== v3.3 Cirrus: graph/crew/reflect/plan/embeddings/cost/trace =====
    {
      name: 'embeddings.add',
      description: 'Add a document to the embedding store. Input: JSON {id, text, meta?}.',
      execute: async (input) => {
        if (!deps.embeddings) return { content: 'embeddings.add: not enabled', error: true };
        try {
          const payload = JSON.parse(input) as { id: string; text: string; meta?: Record<string, unknown> };
          if (!payload.id || !payload.text) return { content: 'embeddings.add: id and text required', error: true };
          await deps.embeddings.add({ id: payload.id, text: payload.text, meta: payload.meta });
          if (deps.embeddingPersistence) {
            try { await deps.embeddingPersistence.save(deps.embeddings, deps.embeddings.all()); } catch { /* best-effort */ }
          }
          return { content: JSON.stringify({ ok: true, size: deps.embeddings.size() }) };
        } catch (e) { return { content: `embeddings.add: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'embeddings.search',
      description: 'Semantic search the embedding store. Input: JSON {query, k?}.',
      execute: async (input) => {
        if (!deps.embeddings) return { content: 'embeddings.search: not enabled', error: true };
        try {
          const payload = JSON.parse(input) as { query: string; k?: number };
          if (!payload.query) return { content: 'embeddings.search: query required', error: true };
          const k = Math.max(1, Math.min(50, payload.k ?? 5));
          const results = await deps.embeddings.search(payload.query, k);
          return { content: JSON.stringify({ results, total: deps.embeddings.size() }) };
        } catch (e) { return { content: `embeddings.search: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'embeddings.size',
      description: 'Return number of indexed documents.',
      execute: () => {
        if (!deps.embeddings) return { content: 'embeddings.size: not enabled', error: true };
        return { content: JSON.stringify({ size: deps.embeddings.size() }) };
      }
    },
    {
      name: 'cost.record',
      description: 'Record a token/cost entry. Input: JSON {tokensIn, tokensOut, toolCalls?, sessionId?, requestId?, labels?}.',
      execute: (input) => {
        if (!deps.costTracker) return { content: 'cost.record: not enabled', error: true };
        try {
          const p = JSON.parse(input) as { tokensIn?: number; tokensOut?: number; toolCalls?: number; sessionId?: string; requestId?: string; labels?: Record<string,string> };
          const rec = deps.costTracker.record({
            sessionId: p.sessionId ?? 'cli',
            requestId: p.requestId ?? `req-${Date.now()}`,
            tokensIn: p.tokensIn ?? 0,
            tokensOut: p.tokensOut ?? 0,
            toolCalls: p.toolCalls ?? 0,
            labels: p.labels ?? {}
          });
          return { content: JSON.stringify({ ok: true, record: rec }) };
        } catch (e) { return { content: `cost.record: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'cost.summary',
      description: 'Return aggregated cost summary (per-label and grand totals).',
      execute: () => {
        if (!deps.costTracker) return { content: 'cost.summary: not enabled', error: true };
        return { content: JSON.stringify(deps.costTracker.summary()) };
      }
    },
    {
      name: 'trace.spans',
      description: 'List recent finished spans. Input: optional JSON {limit}.',
      execute: (input) => {
        if (!deps.tracer) return { content: 'trace.spans: not enabled', error: true };
        let limit = 50;
        if (input && input.trim()) {
          try { limit = Math.max(1, Math.min(500, (JSON.parse(input) as { limit?: number }).limit ?? 50)); } catch { /* default */ }
        }
        return { content: JSON.stringify({ spans: deps.tracer.recent(limit) }) };
      }
    },
    {
      name: 'reflect.revise',
      description: 'Self-critique and revise text. Input: JSON {answer, goal?}.',
      execute: async (input) => {
        if (!deps.reflector) return { content: 'reflect.revise: not enabled', error: true };
        try {
          const p = JSON.parse(input) as { answer: string; goal?: string };
          if (!p.answer) return { content: 'reflect.revise: answer required', error: true };
          const result = await deps.reflector.revise(p.answer, p.goal);
          return { content: JSON.stringify(result) };
        } catch (e) { return { content: `reflect.revise: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'plan.create',
      description: 'Generate a heuristic plan for a goal. Input: JSON {goal, tools?: string[]}.',
      execute: (input) => {
        if (!deps.planner) return { content: 'plan.create: not enabled', error: true };
        try {
          const p = JSON.parse(input) as { goal: string; tools?: string[] };
          if (!p.goal) return { content: 'plan.create: goal required', error: true };
          const plan = deps.planner.plan(p.goal, { availableTools: p.tools ?? [] });
          return { content: JSON.stringify(plan) };
        } catch (e) { return { content: `plan.create: ${(e as Error).message}`, error: true }; }
      }
    },
    // ===== v3.4 Stratus: graph/crew/hmac/trace.size/cost.recent =====
    {
      name: 'graph.run',
      description: 'Run a declarative AgentGraph spec. Input: JSON {entry, nodes:[{id,patch?,setDone?}], edges:[{from,to,whenStateKey?,whenStateEquals?}], initialState?, maxSteps?}.',
      execute: async (input) => {
        try {
          const p = JSON.parse(input) as { entry: string; nodes: Array<{ id: string; patch?: Record<string, unknown>; setDone?: boolean }>; edges: Array<{ from: string; to: string; whenStateKey?: string; whenStateEquals?: unknown }>; initialState?: Record<string, unknown>; maxSteps?: number };
          if (!p.entry || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) return { content: 'graph.run: entry/nodes/edges required', error: true };
          const { AgentGraph, END } = await import('../graph/agent-graph.js');
          const g = new AgentGraph<Record<string, unknown>>();
          for (const n of p.nodes) {
            const patch = n.patch ?? {};
            const setDone = n.setDone === true;
            g.addNode(n.id, () => ({ ...patch, ...(setDone ? { __done: true } : {}) }));
          }
          for (const e of p.edges) {
            const to = e.to === 'END' ? END : e.to;
            if (e.whenStateKey !== undefined) {
              const key = e.whenStateKey;
              const want = e.whenStateEquals;
              g.addEdge(e.from, to, (ctx) => (ctx.state as Record<string, unknown>)[key] === want);
            } else { g.addEdge(e.from, to); }
          }
          g.setEntry(p.entry);
          const result = await g.run(p.initialState ?? {}, { maxSteps: Math.min(64, p.maxSteps ?? 16) });
          return { content: JSON.stringify(result) };
        } catch (e) { return { content: `graph.run: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'crew.run',
      description: 'Run a static-reply Crew. Input: JSON {goal, members:[{name,role,reply,tools?}], maxRounds?}.',
      execute: async (input) => {
        try {
          const p = JSON.parse(input) as { goal: string; members: Array<{ name: string; role: string; reply: string; tools?: string[] }>; maxRounds?: number };
          if (!p.goal || !Array.isArray(p.members) || p.members.length === 0) return { content: 'crew.run: goal and members[] required', error: true };
          const { Crew } = await import('../crew/crew.js');
          const crew = new Crew();
          crew.setMaxTurns(Math.min(8, p.maxRounds ?? 3));
          for (const m of p.members) {
            crew.add({ name: m.name, role: m.role, ...(m.tools ? { tools: m.tools } : {}), handler: () => m.reply });
          }
          const result = await crew.run(p.goal);
          return { content: JSON.stringify(result) };
        } catch (e) { return { content: `crew.run: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'cost.recent',
      description: 'List recent cost records (most recent first). Input: optional JSON {limit, sessionId?}.',
      execute: (input) => {
        if (!deps.costTracker) return { content: 'cost.recent: not enabled', error: true };
        let limit = 20; let sessionId: string | undefined;
        if (input && input.trim()) {
          try {
            const p = JSON.parse(input) as { limit?: number; sessionId?: string };
            if (typeof p.limit === 'number') limit = Math.max(1, Math.min(200, p.limit));
            sessionId = p.sessionId;
          } catch { /* default */ }
        }
        const filter: { limit: number; sessionId?: string } = { limit };
        if (sessionId) filter.sessionId = sessionId;
        return { content: JSON.stringify({ records: deps.costTracker.list(filter) }) };
      }
    },
    {
      name: 'trace.size',
      description: 'Return Tracer counts (active in-flight + recent finished).',
      execute: () => {
        if (!deps.tracer) return { content: 'trace.size: not enabled', error: true };
        return { content: JSON.stringify({ active: deps.tracer.size(), recent: deps.tracer.recent(1000).length }) };
      }
    },
    {
      name: 'hmac.sign',
      description: 'Compute HMAC-SHA256 over a body. Input: JSON {secret, body, algorithm?}. Returns sha256=<hex>.',
      execute: async (input) => {
        try {
          const p = JSON.parse(input) as { secret: string; body: string; algorithm?: 'sha256' | 'sha1' | 'sha512' };
          if (!p.secret || typeof p.body !== 'string') return { content: 'hmac.sign: secret and body required', error: true };
          const { signHmac } = await import('../channels/hmac-verify.js');
          return { content: signHmac(p.secret, p.body, p.algorithm ?? 'sha256') };
        } catch (e) { return { content: `hmac.sign: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'memory.topic',
      description: 'Lazy-load a single MEMORY topic file. Input: JSON {domain}. Returns body or null.',
      execute: async (input) => {
        if (!deps.memoryIndex) return { content: 'memory.topic: not enabled', error: true };
        try {
          const p = JSON.parse(input) as { domain: string };
          if (!p.domain) return { content: 'memory.topic: domain required', error: true };
          const body = await deps.memoryIndex.loadTopic(p.domain);
          return { content: JSON.stringify({ domain: p.domain, body }) };
        } catch (e) { return { content: `memory.topic: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'memory.topics',
      description: 'List available memory topic file names.',
      execute: async () => {
        if (!deps.memoryIndex) return { content: 'memory.topics: not enabled', error: true };
        return { content: JSON.stringify({ topics: await deps.memoryIndex.listTopics() }) };
      }
    },
    {
      name: 'memory.topic.write',
      description: 'Save (overwrite) a memory topic file. Input: JSON {domain, body}. Max 256 KiB.',
      execute: async (input) => {
        if (!deps.memoryIndex) return { content: 'memory.topic.write: not enabled', error: true };
        try {
          const p = JSON.parse(input) as { domain: string; body: string };
          if (!p.domain || typeof p.body !== 'string') return { content: 'memory.topic.write: domain and body required', error: true };
          const r = await deps.memoryIndex.saveTopic(p.domain, p.body);
          return { content: JSON.stringify(r) };
        } catch (e) { return { content: `memory.topic.write: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'skills.extract',
      description: 'Hermes-style: capture a successful task as a reusable skill. Input: JSON {input, output, success?, name?, when?}.',
      execute: async (input) => {
        if (!deps.skillLibrary) return { content: 'skills.extract: not enabled', error: true };
        try {
          const p = JSON.parse(input) as { input: string; output: string; success?: boolean; name?: string; when?: string };
          if (!p.input || !p.output) return { content: 'skills.extract: input and output required', error: true };
          const args: { input: string; output: string; success: boolean; name?: string; when?: string } = {
            input: p.input, output: p.output, success: p.success ?? true
          };
          if (p.name !== undefined) args.name = p.name;
          if (p.when !== undefined) args.when = p.when;
          const skill = await deps.skillLibrary.extract(args);
          return { content: JSON.stringify({ skill }) };
        } catch (e) { return { content: `skills.extract: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'skills.find',
      description: 'Hermes-style retrieval: find skills relevant to a query. Input: JSON {query, k?}.',
      execute: async (input) => {
        if (!deps.skillLibrary) return { content: 'skills.find: not enabled', error: true };
        try {
          const p = JSON.parse(input) as { query: string; k?: number };
          if (!p.query) return { content: 'skills.find: query required', error: true };
          const results = await deps.skillLibrary.findRelevant(p.query, p.k ?? 5);
          return { content: JSON.stringify({ results }) };
        } catch (e) { return { content: `skills.find: ${(e as Error).message}`, error: true }; }
      }
    },
    {
      name: 'skills.size',
      description: 'Return number of skills in the library.',
      execute: async () => {
        if (!deps.skillLibrary) return { content: 'skills.size: not enabled', error: true };
        return { content: JSON.stringify({ size: await deps.skillLibrary.size() }) };
      }
    },
    {
      name: 'identity.read',
      description: 'Read IDENTITY.md (agent metadata card).',
      execute: async () => {
        if (!deps.workspace) return { content: 'identity.read: not enabled', error: true };
        return { content: await deps.workspace.readIdentity() };
      }
    },
    {
      name: 'heartbeat.rules',
      description: 'Parse HEARTBEAT.md into structured rules.',
      execute: async () => {
        if (!deps.workspace) return { content: 'heartbeat.rules: not enabled', error: true };
        return { content: JSON.stringify({ rules: await deps.workspace.parseHeartbeatRules() }) };
      }
    },
    {
      name: 'hmac.verify',
      description: 'Verify HMAC signature. Input: JSON {secret, body, signature, algorithm?}. Returns {ok, reason?}.',
      execute: async (input) => {
        try {
          const p = JSON.parse(input) as { secret: string; body: string; signature: string; algorithm?: 'sha256' | 'sha1' | 'sha512' };
          if (!p.secret || typeof p.body !== 'string' || !p.signature) return { content: 'hmac.verify: secret/body/signature required', error: true };
          const { verifyHmac } = await import('../channels/hmac-verify.js');
          const result = verifyHmac(p.secret, p.body, p.signature, p.algorithm ? { algorithm: p.algorithm } : {});
          return { content: JSON.stringify(result) };
        } catch (e) { return { content: `hmac.verify: ${(e as Error).message}`, error: true }; }
      }
    }
  ];
}
