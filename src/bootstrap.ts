import { AgentRuntime } from './agent/agent-runtime.js';
import { BrainProvider } from './brain/brain.js';
import { AutoCostBrain } from './brain/auto-cost-brain.js';
import { DeterministicBrain } from './brain/deterministic-brain.js';
import { OpenAiBrain } from './brain/openai-brain.js';
import { ToolCache } from './cache/tool-cache.js';
import { BroadcastChannel, ConsoleChannel, InMemoryChannel } from './channels/channel.js';
import { ConversationStore } from './conversation/conversation-store.js';
import { AuditLogger, InMemoryAuditLog } from './core/audit-log.js';
import { MemoryStore } from './core/memory-store.js';
import { PairingStore } from './core/pairing-store.js';
import { PolicyEngine } from './core/policy-engine.js';
import { RateLimiter } from './core/rate-limiter.js';
import { SessionStore } from './core/session-store.js';
import { ToolRegistry } from './core/tool-registry.js';
import { Gateway } from './gateway.js';
import { MetricsRegistry } from './metrics/registry.js';
import { PluginLoader } from './plugins/plugin-loader.js';
import { ToolQuotaManager } from './quotas/tool-quota.js';
import { CronScheduler } from './scheduler/cron.js';
import { SkillsLoader } from './skills/skills-loader.js';
import { LongTermMemory } from './longterm/longterm-memory.js';
import { DailyLog } from './longterm/daily-log.js';
import { SubAgentRunner } from './subagent/subagent-runner.js';
import { NodeRegistry } from './nodes/node-registry.js';
import { HookRunner } from './hooks/hook-runner.js';
import { ContextCompactor } from './compaction/context-compactor.js';
import { WorkspaceFiles } from './workspace/workspace-files.js';
import { Heartbeat } from './heartbeat/heartbeat.js';
import { EmbeddingStore } from './embeddings/embedding-store.js';
import { EmbeddingPersistence } from './embeddings/embedding-persistence.js';
import { CostTracker } from './cost/cost-tracker.js';
import { Tracer } from './tracing/span.js';
import { reflectAndRevise, textHeuristicReflector } from './reflection/reflector.js';
import { HeuristicPlanner } from './planning/planner.js';
import { MemoryIndex } from './memory/memory-index.js';
import { SkillLibrary } from './skills/skill-library.js';
import { AutoSkillExtractor } from './skills/auto-skill-extractor.js';
import { HeartbeatScheduler } from './heartbeat/heartbeat-scheduler.js';
import { buildSystemTools } from './system/system-tools.js';
import { buildBrowserTools } from './browser/browser-tools.js';
import path from 'node:path';
import { JsonFileStore } from './storage/json-store.js';
import { buildBuiltinTools } from './tools/builtin-tools.js';
import { AppConfig, Logger } from './types.js';
import { createLogger } from './utils/logger.js';

export interface BootstrapResult {
  gateway: Gateway;
  runtime: AgentRuntime;
  tools: ToolRegistry;
  policy: PolicyEngine;
  audit: AuditLogger;
  pairing?: PairingStore;
  cache?: ToolCache;
  quotas?: ToolQuotaManager;
  conversation?: ConversationStore;
  metrics?: MetricsRegistry;
  inMemoryChannel: InMemoryChannel;
  consoleChannel: ConsoleChannel;
  broadcastChannel: BroadcastChannel;
  store?: JsonFileStore;
  skills: SkillsLoader;
  scheduler?: CronScheduler;
  logger: Logger;
  longterm: LongTermMemory;
  dailyLog: DailyLog;
  subagent: SubAgentRunner;
  nodes: NodeRegistry;
  hooks: HookRunner;
  compactor: ContextCompactor;
  workspace: WorkspaceFiles;
  heartbeat: Heartbeat;
  embeddings: EmbeddingStore;
  costTracker: CostTracker;
  tracer: Tracer;
  memoryIndex: MemoryIndex;
  skillLibrary: SkillLibrary;
  heartbeatScheduler: HeartbeatScheduler;
  mcpClients: Map<string, import('./mcp/mcp-client.js').McpClient>;
}

export async function bootstrap(config: AppConfig): Promise<BootstrapResult> {
  const logger = createLogger({
    level: config.logging.level,
    json: config.logging.json,
    redactKeys: config.logging.redactKeys
  });

  const memories = new MemoryStore({
    maxPerSession: config.agent.memoryLimit,
    dedupThreshold: config.memory.dedupThreshold
  });
  const sessions = new SessionStore({ defaultAgentId: config.agent.defaultId });
  const policy = new PolicyEngine({ rules: config.policy.rules });
  // ===== OpenClaw-inspired v2.0 subsystems =====
  const longterm = new LongTermMemory(path.join(config.storage.workspaceDir, 'MEMORY.md'));
  const dailyLog = new DailyLog(path.join(config.storage.workspaceDir, 'logs'));
  const nodes = new NodeRegistry();
  const compactor = new ContextCompactor();
  const workspace = new WorkspaceFiles(config.storage.workspaceDir);

  // ===== v3.2/v3.3 Cirrus subsystems =====
  const embeddings = new EmbeddingStore();
  const embeddingPersistence = new EmbeddingPersistence(path.join(config.storage.workspaceDir, 'embeddings.jsonl'));
  try { await embeddingPersistence.restoreInto(embeddings); } catch { /* first-run */ }
  const costTracker = new CostTracker();
  const tracer = new Tracer();
  const reflector = {
    /** Revise text by running one reflection pass over the built-in heuristic reflector. */
    async revise(answer: string, _goal?: string) {
      return reflectAndRevise(answer, textHeuristicReflector, { maxIterations: 2 });
    }
  };
  const planner = new HeuristicPlanner();
  // v3.5 OpenClaw/Hermes parity
  const memoryIndex = new MemoryIndex(config.storage.workspaceDir);
  const skillLibrary = new SkillLibrary(path.join(config.storage.workspaceDir, 'skills'));
  // v3.6: HEARTBEAT.md → timers. Rules are wired below once `subagent` and
  // `dailyLog` exist; the scheduler itself can be created up-front.
  const heartbeatScheduler = new HeartbeatScheduler();

  const tools = new ToolRegistry();
  // SubAgent + skills are registered after AgentRuntime is constructed below;
  // builtin tools see them via the deps closure (mutable refs).
  const lazyDeps: { subagent?: SubAgentRunner; hooks?: HookRunner; heartbeat?: Heartbeat; auditSink?: InMemoryAuditLog; skillsRef?: { list(): Array<{ name: string; description: string; tags: string[] }>; read(name: string): string | undefined } } = {};
  for (const tool of buildBuiltinTools({
    memories,
    longterm,
    dailyLog,
    nodes,
    get subagent() { return lazyDeps.subagent; },
    get hooks() { return lazyDeps.hooks; },
    compactor,
    workspace,
    get heartbeat() { return lazyDeps.heartbeat; },
    get auditSink() { return lazyDeps.auditSink; },
    get skillsLoader() { return lazyDeps.skillsRef; },
    embeddings,
    embeddingPersistence,
    costTracker,
    tracer,
    reflector,
    planner,
    memoryIndex,
    skillLibrary
  } as Parameters<typeof buildBuiltinTools>[0])) tools.register(tool);

  // v3.8: env-gated system + browser tool packs. Both default-DENY — nothing
  // dangerous happens unless the operator opts in by setting env vars.
  const sysAccess = process.env.GARUD_SYSTEM_ACCESS === '1' || process.env.GARUD_SYSTEM_ACCESS === 'true';
  const systemTools = buildSystemTools({
    enabled: sysAccess,
    fsAllow: (process.env.GARUD_FS_ALLOW ?? '').split(':').filter(Boolean),
    execAllow: (process.env.GARUD_EXEC_ALLOW ?? '').split(':').filter(Boolean)
  });
  for (const t of systemTools) try { tools.register(t); } catch { /* duplicate */ }
  const browserOn = process.env.GARUD_BROWSER === '1' || process.env.GARUD_BROWSER === 'true';
  const browserTools = buildBrowserTools({
    enabled: browserOn,
    ...(process.env.GARUD_BROWSER_BIN ? { binary: process.env.GARUD_BROWSER_BIN } : {})
  });
  for (const t of browserTools) try { tools.register(t); } catch { /* duplicate */ }

  if (config.plugins?.length) {
    const loader = new PluginLoader(memories, logger.child('plugins'));
    const plugins = await loader.loadAll(config.plugins, config.storage.workspaceDir);
    for (const plugin of plugins) {
      for (const tool of plugin.tools) {
        try { tools.register(tool); } catch (error) {
          logger.warn('plugin tool conflict', {
            plugin: plugin.id,
            tool: tool.name,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  }

  const skills = new SkillsLoader(config.skillsDir);
  if (config.hotReload) skills.watchForChanges();
  // OpenClaw-style lazy skill access: tools see metadata + read-on-demand.
  lazyDeps.skillsRef = {
    list: () => (skills as unknown as { skills: Array<{ name: string; content: string }> }).skills.map((s) => ({
      name: s.name,
      description: s.content.split('\n').find((l) => l.trim().length > 0)?.slice(0, 200) ?? '',
      tags: ['skill']
    })),
    read: (name) => (skills as unknown as { skills: Array<{ name: string; content: string }> }).skills.find((s) => s.name === name)?.content
  };

  const cache = config.cache.enabled
    ? new ToolCache({
        enabled: true,
        ttlMs: config.cache.ttlMs,
        maxEntries: config.cache.maxEntries
      })
    : undefined;

  const metrics = config.metrics.enabled ? new MetricsRegistry() : undefined;

  const conversation = config.conversation.maxTurns > 0
    ? new ConversationStore({ maxTurns: config.conversation.maxTurns })
    : undefined;

  const quotas = config.quotas.defaultDailyLimit > 0
    ? new ToolQuotaManager({ defaultLimit: config.quotas.defaultDailyLimit })
    : new ToolQuotaManager();

  // Brain pipeline: raw provider → AutoSkillExtractor (learn from replies)
  //              → AutoCostBrain (record tokens/calls)
  // Order matters: AutoCostBrain is outermost so it sees the *final* reply
  // size; AutoSkillExtractor sits inside so a learning failure can't break
  // cost accounting.
  const baseBrain = buildBrain(config);
  const learningBrain = new AutoSkillExtractor(baseBrain, skillLibrary);
  const brain: BrainProvider = new AutoCostBrain(learningBrain, costTracker);

  const audit = new AuditLogger();
  const inMemoryAudit = new InMemoryAuditLog();
  audit.addSink(inMemoryAudit);
  lazyDeps.auditSink = inMemoryAudit;

  let store: JsonFileStore | undefined;
  if (config.storage.persistent) {
    store = new JsonFileStore(config.storage.workspaceDir);
    await store.ensureWorkspace();
    audit.addSink(store.fileSink());
  }

  const rateLimiter = config.rateLimit.enabled
    ? new RateLimiter({
        enabled: true,
        windowMs: config.rateLimit.windowMs,
        maxRequests: config.rateLimit.maxRequests
      })
    : undefined;

  const pairing = config.pairing.enabled
    ? new PairingStore({ codeTtlMs: config.pairing.codeTtlMs })
    : undefined;

  const runtime = new AgentRuntime(brain, memories, tools, policy, {
    maxToolsPerTurn: config.agent.maxToolsPerTurn,
    toolTimeoutMs: config.agent.toolTimeoutMs,
    maxToolResultChars: config.agent.maxToolResultChars,
    contextTurns: config.conversation.contextTurns,
    persona: config.agent.persona,
    logger: logger.child('runtime'),
    audit,
    cache,
    quotas,
    conversation,
    metrics,
    skillsLoader: (input) => skills.match(input, 2)
  });

  // Sub-agent runner needs the runtime, registered post-construction.
  const subagent = new SubAgentRunner(runtime, 4, logger.child('subagent'));
  lazyDeps.subagent = subagent;

  // Hook runner wired to the gateway's event bus (created below).
  // We instantiate it after the gateway so it has access to its bus.

  const gateway = new Gateway(runtime, {
    sessions,
    memories,
    tools,
    policy,
    rateLimiter,
    audit,
    store,
    pairing,
    cache,
    quotas,
    conversation,
    metrics,
    logger: logger.child('gateway'),
    autoPersist: config.storage.persistent
  });

  if (store) await gateway.loadFromDisk();

  // Hook runner wired to the gateway event bus.
  const hooks = new HookRunner(
    { on: (event, handler) => gateway.events.on(event as Parameters<typeof gateway.events.on>[0], handler as never) },
    logger.child('hooks')
  );
  lazyDeps.hooks = hooks;
  // Hold a reference so the variable is always considered used.
  void compactor;

  // Daily-log hook: append every received/replied event to today's daily log.
  gateway.events.on('received', (e) => { void dailyLog.append('user', e.text, { sessionChannel: e.channel, userId: e.userId }); });
  gateway.events.on('replied', (e) => { void dailyLog.append('assistant', e.text, { sessionId: e.sessionId }); });

  const inMemoryChannel = new InMemoryChannel('http');
  const consoleChannel = new ConsoleChannel('console');
  const broadcastChannel = new BroadcastChannel('broadcast');
  gateway.upsertChannel(inMemoryChannel);
  gateway.upsertChannel(consoleChannel);
  gateway.upsertChannel(broadcastChannel);

  let scheduler: CronScheduler | undefined;
  if (config.scheduler.enabled) {
    scheduler = new CronScheduler(logger);
    scheduler.add({
      id: 'heartbeat',
      interval: config.scheduler.heartbeatMs,
      task: async ({ now, log }) => {
        log.debug('heartbeat', { stats: gateway.getStats(), now });
        await audit.record('cron', { id: 'heartbeat', stats: gateway.getStats() });
      }
    });
    if (config.scheduler.sessionTtlMs > 0) {
      scheduler.add({
        id: 'session-prune',
        interval: Math.max(60_000, config.scheduler.heartbeatMs),
        task: async ({ log }) => {
          const removed = sessions.pruneIdle(config.scheduler.sessionTtlMs);
          if (removed > 0) {
            log.info('pruned idle sessions', { removed });
            await audit.record('cron', { id: 'session-prune', removed });
          }
        }
      });
    }
    scheduler.add({
      id: 'memory-prune',
      interval: Math.max(60_000, config.scheduler.heartbeatMs),
      task: async ({ log }) => {
        const removed = memories.pruneExpired();
        if (removed > 0) {
          log.info('pruned expired memories', { removed });
          await audit.record('cron', { id: 'memory-prune', removed });
        }
      }
    });
    // Persist via cron only if autoPersist is OFF — avoid double writes.
    if (store && !config.storage.persistent) {
      scheduler.add({
        id: 'persist',
        interval: Math.max(30_000, config.scheduler.heartbeatMs),
        task: async ({ log }) => {
          try {
            await gateway.persist();
          } catch (error) {
            log.warn('persist cron failed', {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      });
    }
  }

  const heartbeat = new Heartbeat(60_000, () => subagent.pending(), logger.child('heartbeat'));
  lazyDeps.heartbeat = heartbeat;

  // v3.6: parse HEARTBEAT.md and schedule rules. Each fire is recorded as
  // a daily-log entry; the brain can also subscribe via hooks later.
  try {
    const rules = await workspace.parseHeartbeatRules();
    const hbLog = logger.child('heartbeat-rules');
    heartbeatScheduler.schedule(rules, (event) => {
      hbLog.info('heartbeat rule fired', { section: event.section, rule: event.rule, kind: event.kind });
      dailyLog.append('system', `heartbeat[${event.section}] ${event.rule}`, { kind: event.kind }).catch(() => { /* best-effort */ });
    });
  } catch (e) {
    logger.warn('heartbeat scheduler init failed', { error: (e as Error).message });
  }

  return {
    gateway, runtime, tools, policy, audit, pairing, cache, quotas, conversation, metrics,
    inMemoryChannel, consoleChannel, broadcastChannel, store, skills, scheduler, logger,
    longterm, dailyLog, subagent, nodes, hooks, compactor, workspace, heartbeat,
    embeddings, costTracker, tracer,
    memoryIndex, skillLibrary, heartbeatScheduler,
    mcpClients: new Map()
  };
}

function buildBrain(config: AppConfig): BrainProvider {
  if (config.brain.provider === 'openai-compatible'
      && config.brain.apiBase && config.brain.apiKey && config.brain.model) {
    return new OpenAiBrain({
      apiBase: config.brain.apiBase,
      apiKey: config.brain.apiKey,
      model: config.brain.model,
      temperature: config.brain.temperature,
      timeoutMs: config.brain.requestTimeoutMs,
      failureThreshold: config.brain.failureThreshold,
      cooldownMs: config.brain.cooldownMs,
      extraHeaders: config.brain.extraHeaders
    });
  }
  return new DeterministicBrain();
}
