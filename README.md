# 🦅 Garud Agent

[![CI](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-564%20passing-brightgreen)](https://github.com/gopendrasharma89-tech/garud-agent/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Tools](https://img.shields.io/badge/tools-140-purple)]()
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

**Garud** is a **local-first, policy-aware, multi-channel** agent gateway with an OpenClaw-inspired architecture: file-based persistent memory (`MEMORY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`), per-day activity logs, isolated sub-agents, event hooks, paired device nodes, context compaction, heartbeat, pluggable LLM brains, **140 built-in tools**, scheduler, signed webhooks, WebSocket, dashboard, Prometheus metrics, and audit replay — all in **strict TypeScript with zero runtime dependencies**.

> **Version:** 3.5.0 "Cumulus" · Released 2026-05-22

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
    └── 2026-05-22.md  # daily activity log
```

## ✨ Heartbeat

The heartbeat subsystem performs periodic self-checks (default 60s) emitting `{uptimeSec, rssBytes, heapUsedBytes, pendingSubAgents, notes}`. Listeners and probes hook into it for proactive behavior.

## 🚀 Highlights

- 🧠 **Pluggable LLM brain** — deterministic (built-in) or any OpenAI-compatible endpoint
- 🛠️ **140 built-in tools** — memory, math, text, json, crypto, time, geo, validate, color, array, uuid, longterm, daily, agent, node, skills, soul, user, heartbeat
- 🌐 **50+ HTTP endpoints** — REST + Server-Sent Events streaming
- 🔌 **WebSocket server** with auth, ping/pong, broadcast
- 🔐 **Signed webhooks** (HMAC-SHA256) with constant-time verification
- 📊 **Built-in dashboard** at `/` and **Prometheus metrics** at `/metrics`
- 🧾 **Full audit log** with replay endpoint
- ⏰ **Cron-style scheduler** for recurring messages
- 🦅 **Mascot** — `garud mascot` shows the Cumulus falcon
- 🪶 **Zero runtime dependencies**, **strict TypeScript**, **516 tests** in ~14 s

## 🚀 Quick start

```bash
git clone https://github.com/gopendrasharma89-tech/garud-agent.git
cd garud-agent
npm install
npm run build
npm test                    # 623 tests pass
npm start                   # boot HTTP server on :3010
```

CLI:
```bash
npm run cli help            # list commands (shows mascot too)
npm run cli mascot          # show just the falcon
npm run cli version         # garud-agent 3.5.0
npm run cli tools           # list all 162 tools
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
                        RateLimit · Quotas         140 built-in tools
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
| Source files | 68 |
| Test files | 53 |
| Lines of TypeScript | 18,596 |
| Built-in tools | 162 |
| HTTP endpoints | ~70 |
| Test suites | 53 |
| Tests | 623 (all passing) |
| Test runtime | ~17 s |
| Runtime dependencies | 0 |

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

## 📜 License

MIT — see [LICENSE](LICENSE).

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.
