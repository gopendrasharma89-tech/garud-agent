# 🦅 Garud Agent

[![CI](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-488%20passing-brightgreen)](https://github.com/gopendrasharma89-tech/garud-agent/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Tools](https://img.shields.io/badge/tools-133-purple)]()
[![Deps](https://img.shields.io/badge/runtime%20deps-0-success)]()

A **local-first**, **policy-aware**, **multi-channel** agent gateway with **OpenClaw-inspired** architecture: file-based persistent memory (`MEMORY.md`), per-day activity logs, isolated sub-agents, event hooks, paired device nodes, context compaction, pluggable LLM brains, 133 built-in tools, scheduler, signed webhooks, WebSocket, dashboard, Prometheus metrics, and audit replay — all in **strict TypeScript with zero runtime dependencies**.

> **Version:** 2.6.0 "Rajasinha" · Released 2026-05-16

## ✨ OpenClaw-inspired subsystems (v2.0)

- 📄 **`MEMORY.md`** — file-based long-term memory; durable facts that survive restarts
- 📅 **Daily logs** — `workspace/logs/YYYY-MM-DD.md` auto-populated from gateway events
- 🧬 **Sub-agents** — isolated background turns that cannot nest; max 4 concurrent
- 📱 **Device nodes** — paired devices (macOS/iOS/Android/Linux/Windows/browser) with capability invocation
- 🪝 **Hooks** — event-driven extensions with match filters and error isolation
- 🗜 **Context compaction** — summarize older turns when context budget is exceeded
- 📚 **Lazy-loaded skills** — metadata-only by default; full body read on demand

## 🚀 Highlights

- 🧠 **Pluggable LLM brain** — `deterministic` (built-in) or any OpenAI-compatible endpoint
- 🛠️ **133 built-in tools** — memory, math, text, json, crypto, time, geo, validate, color, array, uuid, longterm, daily, agent, node, skills
- 🌐 **20+ HTTP endpoints** — REST + Server-Sent Events streaming
- 🔌 **WebSocket server** with auth, ping/pong, broadcast
- 🔐 **Signed webhooks** (HMAC-SHA256) with constant-time verification
- 📊 **Built-in dashboard** at `/` and **Prometheus metrics** at `/metrics`
- 🧾 **Full audit log** with replay endpoint
- ⏰ **Cron-style scheduler** for recurring messages
- 🔁 **Tool result cache** + **circuit breaker** + **rate limiter** + **per-trust quotas**
- 💾 **Persistent memory** with pinning, TTL, dedup, and importance scoring
- 🪶 **Zero runtime dependencies**, **strict TypeScript**, **411 tests** in ~18 s

## 🚀 Quick Start

```bash
git clone https://github.com/gopendrasharma89-tech/garud-agent.git
cd garud-agent
npm install
npm run build
npm test                    # 488 tests pass
npm start                   # boot HTTP server on :3010
```

CLI:
```bash
npm run cli help            # list commands
npm run cli version         # garud-agent 2.6.0
npm run cli tools           # list all 104 tools
npm run cli doctor          # health check
npm run cli repl            # interactive REPL
```

## 📐 Architecture (OpenClaw-style)

```
                     ┌────────────────┐
   HTTP / WS / CLI ──▶│    Gateway     │──▶ AgentRuntime ──▶ Brain (deterministic / OpenAI)
                     └───────┬────────┘                    │
        Channels             │                             ▼
        ─────────            ▼                       ToolRegistry
        http, console,  Sessions · Memory                  │
        broadcast,      Conversation · Audit               ▼
        webhook         RateLimit · Quotas         133 built-in tools
                        Pairing · CircuitBreaker          + plugins
                        Scheduler · Cache                 + skills
                        ───────────────────
                        OpenClaw v2.0:
                        • LongTermMemory (MEMORY.md)
                        • DailyLog (logs/YYYY-MM-DD.md)
                        • SubAgentRunner (isolated, no-nest)
                        • NodeRegistry (paired devices)
                        • HookRunner (event-driven)
                        • ContextCompactor (summarize/prune)
```

## 📊 Project Stats

| Metric | Value |
|---|---|
| Source files | 45 |
| Test files | 37 |
| Lines of TypeScript | 11,945 |
| Built-in tools | 104 |
| HTTP endpoints | 20+ |
| Test suites | 37 |
| Tests | 411 (all passing) |
| Test runtime | ~18 s |
| Runtime dependencies | 0 |

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

## 📜 License

MIT — see [LICENSE](LICENSE).

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for full version history.
