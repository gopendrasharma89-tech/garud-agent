// =============================================================================
// Garud Agent — Shared types
// =============================================================================

export type TrustLevel = 'owner' | 'trusted' | 'guest' | 'blocked';
export type SessionRole = 'main' | 'channel' | 'automation' | 'system';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IncomingMessage {
  channel: string;
  userId: string;
  text: string;
  trustLevel?: TrustLevel;
  metadata?: Record<string, unknown>;
  /** Optional client-generated id for deduplication. */
  clientId?: string;
  /** Optional agent id for multi-agent routing. */
  agentId?: string;
  /** Optional request id for tracing across audit/log entries. */
  requestId?: string;
}

export interface Session {
  id: string;
  channel: string;
  userId: string;
  trustLevel: TrustLevel;
  role: SessionRole;
  agentId: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Free-form per-session settings. */
  settings: Record<string, unknown>;
}

export interface Memory {
  id: string;
  sessionId: string;
  text: string;
  tags: string[];
  importance: number;
  createdAt: number;
  /** When defined, the memory is dropped after this timestamp. */
  expiresAt?: number;
  /** Pinned memories are never evicted by capacity. */
  pinned?: boolean;
  /** Optional pre-computed token list for retrieval acceleration. */
  tokens?: string[];
}

export interface ConversationTurn {
  sessionId: string;
  ts: number;
  requestId?: string;
  input: string;
  reply: string;
  toolsUsed: string[];
}

export interface ToolContext {
  session: Session;
  requestText: string;
  now: number;
  /** Logger scoped to this tool invocation. */
  log: Logger;
  /** Abort signal for cooperative cancellation. */
  signal: AbortSignal;
  /** Whether the policy engine asked the tool to run sandboxed. */
  sandbox?: boolean;
  /** Optional request id for tracing. */
  requestId?: string;
  /** Composition helper: invoke another tool from within this tool. */
  invoke?: (toolName: string, input: string) => Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  metadata?: Record<string, unknown>;
  error?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputHint?: string;
  tags?: string[];
  aliases?: string[];
  cacheable?: boolean;
  /** Per-session daily quota; undefined = unlimited. */
  dailyQuota?: number;
  execute: (input: string, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface ToolCall {
  tool: string;
  input: string;
}

export interface AgentPlan {
  summary: string;
  memoryQueries: string[];
  toolCalls: ToolCall[];
}

export interface AgentReply {
  text: string;
  notes: string[];
  usedTools: string[];
  usedMemories: string[];
  citations?: Array<{ id: string; text: string }>;
  requestId?: string;
}

export interface ChannelAdapter {
  name: string;
  deliver: (session: Session, reply: AgentReply) => Promise<void> | void;
  shutdown?: () => Promise<void> | void;
}

export interface PolicyDecision {
  allow: boolean;
  reason: string;
  sandbox?: boolean;
}

export interface PolicyRule {
  id: string;
  trustLevels?: TrustLevel[];
  tools?: string[];
  tags?: string[];
  effect: 'allow' | 'deny';
  sandbox?: boolean;
  reason?: string;
}

export interface AuditEntry {
  id: string;
  ts: number;
  kind: 'message' | 'reply' | 'tool' | 'policy' | 'error' | 'system' | 'pairing' | 'cron' | 'quota';
  sessionId?: string;
  requestId?: string;
  detail: Record<string, unknown>;
}

export interface RateLimitState {
  windowStart: number;
  count: number;
}

export interface PairingRecord {
  code: string;
  channel: string;
  userId: string;
  trustLevel: TrustLevel;
  expiresAt: number;
  createdAt: number;
}

export interface CronJobConfig {
  id: string;
  interval: string | number;
  enabled?: boolean;
  /** Fire the job once immediately when the scheduler starts it. */
  runOnStart?: boolean;
  task: (ctx: { now: number; log: Logger }) => Promise<void> | void;
}

export interface PluginEntry {
  id: string;
  module: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface AppConfig {
  port: number;
  host: string;
  authToken?: string;
  /** Optional read-only token; allows GET endpoints but not mutations. */
  readToken?: string;
  cors: { enabled: boolean; origins: string[] };
  agent: {
    name: string;
    persona: string;
    memoryLimit: number;
    toolTimeoutMs: number;
    maxToolsPerTurn: number;
    defaultId: string;
    /** Auto-truncate tool result content to this many characters. */
    maxToolResultChars: number;
  };
  policy: { sandboxGuests: boolean; denyByDefaultForGuests: boolean; rules: PolicyRule[] };
  rateLimit: { enabled: boolean; windowMs: number; maxRequests: number };
  storage: { workspaceDir: string; persistent: boolean };
  brain: {
    provider: 'deterministic' | 'openai-compatible';
    apiBase?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    requestTimeoutMs?: number;
    failureThreshold?: number;
    cooldownMs?: number;
    /** Extra headers for proxy/OpenRouter compatibility. */
    extraHeaders?: Record<string, string>;
  };
  cache: { enabled: boolean; ttlMs: number; maxEntries: number };
  logging: { level: LogLevel; json: boolean; redactKeys?: string[] };
  scheduler: { enabled: boolean; heartbeatMs: number; sessionTtlMs: number };
  pairing: { enabled: boolean; codeTtlMs: number };
  websocket: { enabled: boolean; path: string; token?: string };
  metrics: { enabled: boolean };
  dashboard: { enabled: boolean };
  webhook: {
    enabled: boolean;
    pathPrefix: string;
    /** Optional HMAC secret; when set, requests must carry x-garud-signature. */
    signingSecret?: string;
  };
  conversation: {
    /** Max history turns kept per session; 0 disables. */
    maxTurns: number;
    /** Max turns injected into compose context. */
    contextTurns: number;
  };
  quotas: {
    /** Optional default daily limit per (session, tool); 0 disables. */
    defaultDailyLimit: number;
  };
  memory: {
    /** Soft duplicate Jaccard threshold; 0 disables dedup on save. */
    dedupThreshold: number;
  };
  plugins: PluginEntry[];
  skillsDir?: string;
  hotReload: boolean;
}

export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  child: (scope: string) => Logger;
}
