# 🦅 Garud Agent

[![CI](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-67%20passing-brightgreen)](https://github.com/gopendrasharma89-tech/garud-agent/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Tools](https://img.shields.io/badge/tools-187-purple)]()
[![Deps](https://img.shields.io/badge/runtime%20deps-0-success)]()

```
        ___                          ___
       /   \    ___    ___    /   \
      |     \__/   \__/   \__/     |
       \__   //O  <  O\\   __/
          \__\____/__/
              |||
             /   \
            GARUD
```

**Garud** is a **local-first, policy-aware, multi-channel** agent gateway with an OpenClaw-inspired architecture: file-based persistent memory (`MEMORY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`), per-day activity logs, isolated sub-agents, event hooks, paired device nodes, context compaction, heartbeat, pluggable LLM brains, **187 built-in tools**, scheduler, signed webhooks, WebSocket, dashboard, Prometheus metrics, and audit replay — all in **strict TypeScript with zero runtime dependencies**.

> **Version:** 5.0.0 "Talon" · Released 2026-08-02

## 🦞→🦅 OpenClaw parity (v5.0.0 "Talon")

The gateway is now a full chat-native control plane:

- **Slash commands everywhere** — `/help` `/status` `/whoami` `/new` `/compact` `/pair <code>` `/version` work on every channel (WebChat, Telegram, webhooks). Deterministic, zero LLM cost. Extend with `ChatCommandRouter.register()`.
- **DM policy gate** — per-channel `open | pairing | allowlist | disabled`. With `pairing`, strangers get a one-time code and stay locked out until you run `garud pairing approve --code <code>`.
- **Multi-agent routing** — bind channels/users to different agents; most-specific binding wins.
- **Queue modes** — per-session `queue` (FIFO), `steer` (new message supersedes stale pending ones), or `reject`.
- **Telegram, live** — `TelegramPoller` long-polls `getUpdates`; no public URL, no tunnel. Replies auto-chunk at 4096 chars.
- **`garud onboard`** — one command seeds a complete workspace (`garud.json`, `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md`, `HEARTBEAT.md`, `MEMORY.md`, `skills/`, `logs/`) with safe defaults.
- **WebChat** — open `http://127.0.0.1:3010/webchat` and start chatting.

```jsonc
// garud.json
{
  "dmPolicy": { "defaultPolicy": "pairing", "channels": { "http": "open" } },
  "routing": { "bindings": [{ "agentId": "boss", "channel": "telegram", "userId": "42" }] },
  "queue": { "mode": "steer" },
  "commands": { "enabled": true }
}
```

```ts
import { TelegramPoller, HttpTelegramTransport } from './src/channels/pollers/telegram-poller.js';
const poller = new TelegramPoller({
  transport: new HttpTelegramTransport(process.env.TELEGRAM_BOT_TOKEN!),
  handle: (m) => gateway.handle(m)
});
gateway.upsertChannel(poller);
poller.start();
```

## 🎯 Retrieval correctness & budgets (v4.7)

Semantic search now returns what it should, and spending has guardrails:

- **Fixed TF-IDF scoring** — similarity is computed per-term at query time with live document frequencies; the old dense vectors silently misaligned as the vocabulary grew and could drop the best match entirely
- **Metadata-filtered retrieval** — `embeddings.search` and hybrid RRF search accept a `filter` predicate over document metadata
- **Cost budgets** — set global or per-session limits (tokens, tool calls, USD) via `cost.setBudget` and check them with `cost.budgetStatus`
- **Snapshot retention** — `pruneSnapshots(keep)` caps workspace snapshot history
- Heartbeat `daily at HH:MM` rules re-anchor to the wall clock every day (DST-safe), and hook re-registration can no longer double-fire

## 🛡️ Orchestration hardening (v4.6)

Crews, sub-agents, workflows, and the event bus are now production-tough:

- **`Crew.run(goal, { signal, turnTimeoutMs })`** — cancel a crew mid-run and bound each agent turn; one stuck member can't wedge the roster
- **Sub-agent cancellation that actually cancels** — `subAgents.cancel(id)` aborts running jobs via per-job `AbortSignal`, and settled jobs auto-prune after `retentionMs`
- **Durable workflow retries** — `{ name, run, retries, retryDelayMs }` re-runs flaky steps before checkpointing an error; duplicate step names are rejected up front
- **`EventBus.once()` / `EventBus.waitFor(event, timeoutMs)`** — single-shot listeners and awaitable events, with snapshot-safe emits

## ✨ Channel adapters (v3.0)

Garud now ships with three first-class **working** channel adapters. All zero-dependency — they parse the platform's raw JSON without any external SDK:

- 💬 **WhatsApp Cloud API** — `POST /channel/whatsapp`
- ✈️ **Telegram Bot API** — `POST /channel/telegram`
- 🎮 **Discord interactions + webhooks** — `POST /channel/discord` (with auto PING/PONG)

## ✨ OpenClaw-style workspace

The `workspace/` directory is the agent's home. It's human-editable, git-friendly markdown:

```
workspace/
├── SOUL.md            # agent personality, voice, boundaries
├── AGENTS.md          # declarative agent roster
├── MEMORY.md          # long-term durable facts
├── users/
│   └── alice.md       # per-user profile
└── logs/
    └── 2026-07-16.md  # daily activity log
```

## ✨ Heartbeat

The heartbeat subsystem performs periodic self-checks (default 60s) emitting `{uptimeSec, rssBytes, heapUsedBytes, pendingSubAgents, notes}`. Listeners and probes hook into it for proactive behavior.

## 🧠 LLM-driven planning (v4.5)

With an OpenAI-compatible brain configured, set `GARUD_LLM_PLANNING=1` and Garud
plans each turn with the model instead of regex rules:

- **Per-turn planning** — the brain asks the LLM which tools to call and which
  memory queries to run (strict-JSON contract: `{summary, memoryQueries, toolCalls}`).
- **Task decomposition** — `plan.create` upgrades to an LLM planner that breaks a
  goal into ordered sub-tasks with tool hints and cycle-free dependencies.
- **Validated & safe** — model output is parsed defensively (fences, prose,
  partial JSON), unknown tools are dropped, and every failure falls back to the
  zero-cost deterministic planner. Offline behaviour is unchanged.

```bash
GARUD_BRAIN=openai-compatible \
OPENAI_API_BASE=https://api.openai.com/v1 \
OPENAI_API_KEY=sk-... \
GARUD_LLM_MODEL=gpt-4o-mini \
GARUD_LLM_PLANNING=1 garud serve
```

## 🚀 Highlights

- 🧠 **Pluggable LLM brain** — deterministic (built-in) or any OpenAI-compatible endpoint
- 🛠️ **187 built-in tools** — memory, math, text, json, crypto, time, geo, validate, color, array, uuid, longterm, daily, agent, node, skills, soul, user, heartbeat
- 🌐 **50+ HTTP endpoints** — REST + Server-Sent Events streaming
- 🔌 **WebSocket server** with auth, ping/pong, broadcast
- 🔐 **Signed webhooks** (HMAC-SHA256) with constant-time verification
- 📊 **Built-in dashboard** at `/` and **Prometheus metrics** at `/metrics`
- 🧾 **Full audit log** with replay endpoint
- ⏰ **Cron-style scheduler** for recurring messages
- 🦅 **Mascot** — `garud mascot` shows the Skyforge falcon
- 🪶 **Zero runtime dependencies**, **strict TypeScript**, **67 tests** in ~20 s
- 🔌 **Per-tool circuit breakers** — repeatedly failing tools are auto-isolated until a cooldown passes (opt-in)

## 🚀 Quick start

```bash
git clone https://github.com/gopendrasharma89-tech/garud-agent.git
cd garud-agent
npm install
npm run build
npm test                    # 692 tests pass
npm start                   # boot HTTP server on :3010
```

CLI:
```bash
npm run cli help            # list commands (shows mascot too)
npm run cli mascot          # show just the falcon
npm run cli version         # garud-agent 4.5.0
npm run cli tools           # list all 176 tools
npm run cli doctor          # health check
npm run cli repl            # interactive REPL
```

## 📐 Architecture

```
                     ┌────────────────┐
   HTTP / WS / CLI ──▶│    Gateway     │──▶ AgentRuntime ──▶ Brain
   WhatsApp           └───────┬────────┘                    │
   Telegram                   │                             ▼
   Discord                    ▼                       ToolRegistry
                        Sessions · Memory                  │
                        Conversation · Audit               ▼
                        RateLimit · Quotas         176 built-in tools
                        Pairing · CircuitBreaker          + plugins
                        Scheduler · Cache                 + skills
                        ───────────────────
                        OpenClaw v2.0+:
                        • LongTermMemory (MEMORY.md)
                        • DailyLog (logs/YYYY-MM-DD.md)
                        • SubAgentRunner (isolated, no-nest)
                        • NodeRegistry (paired devices)
                        • HookRunner (event-driven)
                        • ContextCompactor (summarize/prune)
                        • WorkspaceFiles (SOUL/USER/AGENTS)
                        • Heartbeat (periodic self-check)
```

## 📊 Project stats

| Metric | Value |
|---|---|
| Source files | 83 |
| Test files | 59 |
| Lines of TypeScript | 21,67 |
| Built-in tools | 187 |
| HTTP endpoints | ~89 |
| Test suites | 59 |
| Tests | 67 (all passing) |
| Test runtime | ~17 s |
| Runtime dependencies | 0 |

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

## 📜 License

MIT — see [LICENSE](LICENSE).

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.
