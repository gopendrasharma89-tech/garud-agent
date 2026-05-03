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
      description: 'Intersection of two JSON arrays (preserves order from left). Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'array.intersect: needs <a>::<b>', error: true };
        try {
          const a = JSON.parse(input.slice(0, sep));
          const b = JSON.parse(input.slice(sep + 2));
          if (!Array.isArray(a) || !Array.isArray(b)) return { content: 'array.intersect: both must be arrays', error: true };
          const bSet = new Set(b.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)));
          const out = a.filter((x) => bSet.has(typeof x === 'object' ? JSON.stringify(x) : String(x)));
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.intersect error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'array.diff',
      description: 'Items in left not in right. Input: "<a>::<b>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const sep = input.indexOf('::');
        if (sep === -1) return { content: 'array.diff: needs <a>::<b>', error: true };
        try {
          const a = JSON.parse(input.slice(0, sep));
          const b = JSON.parse(input.slice(sep + 2));
          if (!Array.isArray(a) || !Array.isArray(b)) return { content: 'array.diff: both must be arrays', error: true };
          const bSet = new Set(b.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)));
          const out = a.filter((x) => !bSet.has(typeof x === 'object' ? JSON.stringify(x) : String(x)));
          return { content: JSON.stringify(out) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `array.diff error: ${msg}`, error: true };
        }
      }
    },
    {
      name: 'text.padLeft',
      description: 'Pad string on left. Input: "<text>::<width>::<char>" (char optional, default " ").',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::');
        if (parts.length < 2) return { content: 'text.padLeft: needs <text>::<width>[::<char>]', error: true };
        const text = parts[0]!;
        const width = parseInt(parts[1]!, 10);
        const ch = parts[2] || ' ';
        if (!Number.isFinite(width) || width < 0 || width > 10_000) return { content: 'text.padLeft: invalid width', error: true };
        return { content: text.padStart(width, ch.charAt(0) || ' ') };
      }
    },
    {
      name: 'text.padRight',
      description: 'Pad string on right. Input: "<text>::<width>::<char>".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const parts = input.split('::');
        if (parts.length < 2) return { content: 'text.padRight: needs <text>::<width>[::<char>]', error: true };
        const text = parts[0]!;
        const width = parseInt(parts[1]!, 10);
        const ch = parts[2] || ' ';
        if (!Number.isFinite(width) || width < 0 || width > 10_000) return { content: 'text.padRight: invalid width', error: true };
        return { content: text.padEnd(width, ch.charAt(0) || ' ') };
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
      description: 'Validate email syntax. Returns "true" / "false".',
      tags: ['read', 'safe'],
      execute: (input) => {
        const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
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
    }
  ];
}
