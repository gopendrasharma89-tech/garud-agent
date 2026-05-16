# Architecture

Garud Agent is a **local-first, policy-aware, multi-channel agent gateway** inspired by [OpenClaw](https://docs.openclaw.ai). It transforms a stateless LLM into a persistent, tool-using assistant.

## High-level flow

```
HTTP / WS / CLI
       │
       ▼
   Gateway ──▶ Sessions / Memory / Conversation / Audit
       │              │
       ▼              ▼
  AgentRuntime ──▶ ToolRegistry (128 tools + plugins + skills)
       │
       ▼
    Brain (deterministic | openai-compatible)
```

Every message flows through a single **Gateway** (single-writer for state) that owns the event bus, session store, memory, policy, rate limiter, and quotas.

## OpenClaw-inspired subsystems (v2.0+)

| Subsystem | File | Purpose |
|---|---|---|
| **`LongTermMemory`** | `src/longterm/longterm-memory.ts` | Durable `MEMORY.md` facts across restarts; sections, search, history, byDate |
| **`DailyLog`** | `src/longterm/daily-log.ts` | Per-day markdown logs at `workspace/logs/YYYY-MM-DD.md` |
| **`SubAgentRunner`** | `src/subagent/subagent-runner.ts` | Background isolated turns; no-nest; max 4 concurrent |
| **`NodeRegistry`** | `src/nodes/node-registry.ts` | Paired devices with capability advertisement and async invoke/wait |
| **`HookRunner`** | `src/hooks/hook-runner.ts` | Event-driven hooks with match filters and error isolation |
| **`ContextCompactor`** | `src/compaction/context-compactor.ts` | Summarize + prune older turns when budget exceeded |

## Subsystem catalog

- **`agent/agent-runtime.ts`** — wraps the brain + tool registry + memory; runs a single turn
- **`brain/`** — `BrainProvider` interface plus `DeterministicBrain` (zero-dep fallback) and `OpenAiBrain` (any OpenAI-compatible endpoint)
- **`core/`** — `event-bus`, `memory-store`, `session-store`, `policy-engine`, `tool-registry`, `audit-log`, `rate-limiter`, `pairing-store`, `circuit-breaker`
- **`channels/`** — HTTP, console, broadcast (more adapters planned: WhatsApp, Telegram, Discord)
- **`cache/tool-cache.ts`** — LRU cache for deterministic tool results
- **`conversation/conversation-store.ts`** — turn history per session, with cap
- **`metrics/registry.ts`** — Prometheus-style counters, gauges, histograms
- **`middleware/dashboard.ts`** — built-in HTML dashboard at `/`
- **`plugins/plugin-loader.ts`** — runtime-loaded TypeScript plugins
- **`quotas/tool-quota.ts`** — per-trust-level usage caps
- **`scheduler/cron.ts`** — interval-based jobs
- **`skills/skills-loader.ts`** — hot-loaded markdown skill files (lazy access)
- **`storage/json-store.ts`** — atomic JSON file writes + JSONL audit sink
- **`tools/builtin-tools.ts`** — 128 built-in tools
- **`webhook/signature.ts`** — HMAC-SHA256 verification
- **`ws/ws-server.ts`** — raw HTTP-upgrade WebSocket server with auth + ping/pong + broadcast

## Persistence layout

```
workspace/
├── state.json         # gateway snapshot (sessions, memories)
├── audit.log          # JSONL audit sink
├── MEMORY.md          # long-term facts
├── logs/
│   └── 2026-05-16.md  # daily activity logs
├── plugins/           # *.ts files loaded at startup
└── skills/            # *.md files loaded at startup
```

## Channel-agnostic Gateway

All channels (HTTP, console, WebSocket, broadcast, webhook) normalize their input into an `IncomingMessage` and call `gateway.handle(...)`. The Gateway:

1. Looks up or creates the session
2. Checks the rate limiter and quotas
3. Applies the policy engine (trust-based tool gating)
4. Hands off to `AgentRuntime`
5. Records audit entries
6. Emits events on the bus
7. Returns the reply

This means **adding a new channel = writing one adapter class that calls `gateway.handle`** — no other code changes.

## Why zero runtime deps?

- Smaller attack surface (no transitive supply-chain risk)
- Trivial to audit (~13.5k LoC, all human-written)
- Faster cold-start
- Trustable local-first deployment

All HTTP, WebSocket, crypto, and storage features use Node's standard library directly.
