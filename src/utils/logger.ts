import { Logger, LogLevel } from '../types.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  scope?: string;
  sink?: (line: string) => void;
  redactKeys?: string[];
}

const DEFAULT_REDACT_KEYS = [
  'apikey', 'api_key', 'token', 'password', 'authorization',
  'secret', 'cookie', 'set-cookie', 'bearer', 'signingsecret'
];

function redact(meta: Record<string, unknown> | undefined, keys: Set<string>): Record<string, unknown> | undefined {
  if (!meta) return meta;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (keys.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>, keys);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level: LogLevel = options.level ?? 'info';
  const json = options.json ?? false;
  const scope = options.scope ?? 'garud';
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const redactKeys = new Set([
    ...DEFAULT_REDACT_KEYS,
    ...((options.redactKeys ?? []).map((k) => k.toLowerCase()))
  ]);

  function emit(at: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[at] < LEVEL_ORDER[level]) return;
    const redacted = redact(meta, redactKeys);
    const ts = new Date().toISOString();
    if (json) {
      sink(JSON.stringify({ ts, level: at, scope, msg, ...(redacted ?? {}) }));
    } else {
      const metaPart = redacted && Object.keys(redacted).length ? ' ' + JSON.stringify(redacted) : '';
      sink(`[${ts}] ${at.toUpperCase().padEnd(5)} ${scope} :: ${msg}${metaPart}`);
    }
  }

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (childScope) => createLogger({ ...options, scope: `${scope}:${childScope}` })
  };
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger
};
