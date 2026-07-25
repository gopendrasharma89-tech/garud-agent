import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { AppConfig, LogLevel } from './types.js';
import { DEFAULT_RULES } from './core/policy-engine.js';

export const defaultConfig: AppConfig = {
  port: Number(process.env.GARUD_PORT ?? process.env.PORT ?? 3010),
  host: process.env.GARUD_HOST ?? '127.0.0.1',
  authToken: process.env.GARUD_AUTH_TOKEN || undefined,
  readToken: process.env.GARUD_READ_TOKEN || undefined,
  cors: {
    enabled: process.env.GARUD_CORS === '1',
    origins: (process.env.GARUD_CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean)
  },
  agent: {
    name: process.env.GARUD_AGENT_NAME ?? 'Garud',
    persona: process.env.GARUD_PERSONA ?? 'You are Garud, a concise local-first AI assistant.',
    memoryLimit: Number(process.env.GARUD_MEMORY_LIMIT ?? 1000),
    toolTimeoutMs: Number(process.env.GARUD_TOOL_TIMEOUT_MS ?? 5000),
    maxToolsPerTurn: Number(process.env.GARUD_MAX_TOOLS_PER_TURN ?? 6),
    defaultId: process.env.GARUD_AGENT_ID ?? 'main',
    maxToolResultChars: Number(process.env.GARUD_MAX_TOOL_RESULT_CHARS ?? 4096)
  },
  policy: { sandboxGuests: true, denyByDefaultForGuests: true, rules: DEFAULT_RULES },
  rateLimit: {
    enabled: process.env.GARUD_RATE_LIMIT !== '0',
    windowMs: Number(process.env.GARUD_RATE_WINDOW_MS ?? 60_000),
    maxRequests: Number(process.env.GARUD_RATE_MAX ?? 30)
  },
  storage: {
    workspaceDir: process.env.GARUD_WORKSPACE ?? path.join(os.homedir(), '.garud-agent'),
    persistent: process.env.GARUD_PERSIST !== '0'
  },
  brain: {
    provider: (process.env.GARUD_BRAIN as AppConfig['brain']['provider']) ?? 'deterministic',
    apiBase: process.env.OPENAI_API_BASE ?? process.env.GARUD_LLM_API_BASE,
    apiKey: process.env.OPENAI_API_KEY ?? process.env.GARUD_LLM_API_KEY,
    model: process.env.GARUD_LLM_MODEL ?? 'gpt-4o-mini',
    temperature: process.env.GARUD_LLM_TEMPERATURE ? Number(process.env.GARUD_LLM_TEMPERATURE) : 0.4,
    requestTimeoutMs: Number(process.env.GARUD_LLM_TIMEOUT_MS ?? 20_000),
    failureThreshold: Number(process.env.GARUD_LLM_FAILURE_THRESHOLD ?? 5),
    cooldownMs: Number(process.env.GARUD_LLM_COOLDOWN_MS ?? 30_000),
    llmPlanning: process.env.GARUD_LLM_PLANNING === '1' || process.env.GARUD_LLM_PLANNING === 'true'
  },
  cache: {
    enabled: process.env.GARUD_CACHE !== '0',
    ttlMs: Number(process.env.GARUD_CACHE_TTL_MS ?? 30_000),
    maxEntries: Number(process.env.GARUD_CACHE_MAX ?? 200)
  },
  logging: {
    level: (process.env.GARUD_LOG_LEVEL as LogLevel) ?? 'info',
    json: process.env.GARUD_LOG_JSON === '1',
    redactKeys: (process.env.GARUD_LOG_REDACT ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  },
  scheduler: {
    enabled: process.env.GARUD_SCHEDULER !== '0',
    heartbeatMs: Number(process.env.GARUD_HEARTBEAT_MS ?? 60_000),
    sessionTtlMs: Number(process.env.GARUD_SESSION_TTL_MS ?? 0)
  },
  pairing: {
    enabled: process.env.GARUD_PAIRING !== '0',
    codeTtlMs: Number(process.env.GARUD_PAIRING_TTL_MS ?? 600_000)
  },
  websocket: {
    enabled: process.env.GARUD_WS !== '0',
    path: process.env.GARUD_WS_PATH ?? '/ws',
    token: process.env.GARUD_WS_TOKEN
  },
  metrics: { enabled: process.env.GARUD_METRICS !== '0' },
  dashboard: { enabled: process.env.GARUD_DASHBOARD !== '0' },
  webhook: {
    enabled: process.env.GARUD_WEBHOOK !== '0',
    pathPrefix: process.env.GARUD_WEBHOOK_PREFIX ?? '/webhook',
    signingSecret: process.env.GARUD_WEBHOOK_SECRET
  },
  conversation: {
    maxTurns: Number(process.env.GARUD_CONVERSATION_MAX_TURNS ?? 50),
    contextTurns: Number(process.env.GARUD_CONVERSATION_CONTEXT_TURNS ?? 3)
  },
  quotas: {
    defaultDailyLimit: Number(process.env.GARUD_DEFAULT_DAILY_QUOTA ?? 0)
  },
  memory: {
    dedupThreshold: process.env.GARUD_MEMORY_DEDUP_THRESHOLD
      ? Number(process.env.GARUD_MEMORY_DEDUP_THRESHOLD)
      : 0
  },
  plugins: [],
  skillsDir: process.env.GARUD_SKILLS_DIR,
  hotReload: process.env.GARUD_HOT_RELOAD === '1'
};

export async function loadConfigFile(filePath?: string): Promise<Partial<AppConfig>> {
  const target = filePath ?? path.join(defaultConfig.storage.workspaceDir, 'garud.json');
  try {
    const raw = await fs.readFile(target, 'utf8');
    return JSON.parse(raw) as Partial<AppConfig>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw error;
  }
}

export function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...override,
    cors: { ...base.cors, ...(override.cors ?? {}) },
    agent: { ...base.agent, ...(override.agent ?? {}) },
    policy: { ...base.policy, ...(override.policy ?? {}) },
    rateLimit: { ...base.rateLimit, ...(override.rateLimit ?? {}) },
    storage: { ...base.storage, ...(override.storage ?? {}) },
    brain: { ...base.brain, ...(override.brain ?? {}) },
    cache: { ...base.cache, ...(override.cache ?? {}) },
    logging: { ...base.logging, ...(override.logging ?? {}) },
    scheduler: { ...base.scheduler, ...(override.scheduler ?? {}) },
    pairing: { ...base.pairing, ...(override.pairing ?? {}) },
    websocket: { ...base.websocket, ...(override.websocket ?? {}) },
    metrics: { ...base.metrics, ...(override.metrics ?? {}) },
    dashboard: { ...base.dashboard, ...(override.dashboard ?? {}) },
    webhook: { ...base.webhook, ...(override.webhook ?? {}) },
    conversation: { ...base.conversation, ...(override.conversation ?? {}) },
    quotas: { ...base.quotas, ...(override.quotas ?? {}) },
    memory: { ...base.memory, ...(override.memory ?? {}) },
    plugins: override.plugins ?? base.plugins
  };
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
}

export function validateConfig(config: AppConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (config.port < 0 || config.port > 65535) {
    issues.push({ path: 'port', message: 'must be between 0 and 65535' });
  }
  if (config.agent.maxToolsPerTurn < 1) {
    issues.push({ path: 'agent.maxToolsPerTurn', message: 'must be >= 1' });
  }
  if (config.agent.toolTimeoutMs < 0) {
    issues.push({ path: 'agent.toolTimeoutMs', message: 'must be >= 0' });
  }
  if (config.agent.memoryLimit < 0) {
    issues.push({ path: 'agent.memoryLimit', message: 'must be >= 0' });
  }
  if (config.agent.maxToolResultChars < 64) {
    issues.push({ path: 'agent.maxToolResultChars', message: 'must be >= 64' });
  }
  if (config.rateLimit.windowMs <= 0) {
    issues.push({ path: 'rateLimit.windowMs', message: 'must be > 0' });
  }
  if (config.rateLimit.maxRequests < 1) {
    issues.push({ path: 'rateLimit.maxRequests', message: 'must be >= 1' });
  }
  if (config.brain.provider === 'openai-compatible'
      && (!config.brain.apiBase || !config.brain.apiKey || !config.brain.model)) {
    issues.push({ path: 'brain', message: 'openai-compatible requires apiBase, apiKey, and model' });
  }
  if (config.scheduler.heartbeatMs < 1000) {
    issues.push({ path: 'scheduler.heartbeatMs', message: 'must be >= 1000' });
  }
  if (config.pairing.codeTtlMs < 10_000) {
    issues.push({ path: 'pairing.codeTtlMs', message: 'must be >= 10000' });
  }
  if (config.cache.ttlMs <= 0) {
    issues.push({ path: 'cache.ttlMs', message: 'must be > 0' });
  }
  if (config.cache.maxEntries < 1) {
    issues.push({ path: 'cache.maxEntries', message: 'must be >= 1' });
  }
  if (!config.websocket.path.startsWith('/')) {
    issues.push({ path: 'websocket.path', message: 'must start with /' });
  }
  if (!config.webhook.pathPrefix.startsWith('/')) {
    issues.push({ path: 'webhook.pathPrefix', message: 'must start with /' });
  }
  if (config.conversation.maxTurns < 0) {
    issues.push({ path: 'conversation.maxTurns', message: 'must be >= 0' });
  }
  if (config.conversation.contextTurns < 0) {
    issues.push({ path: 'conversation.contextTurns', message: 'must be >= 0' });
  }
  if (config.memory.dedupThreshold < 0 || config.memory.dedupThreshold > 1) {
    issues.push({ path: 'memory.dedupThreshold', message: 'must be in [0, 1]' });
  }
  if (config.quotas.defaultDailyLimit < 0) {
    issues.push({ path: 'quotas.defaultDailyLimit', message: 'must be >= 0' });
  }
  return issues;
}
