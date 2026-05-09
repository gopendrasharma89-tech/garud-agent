# Changelog

All notable changes to **Garud Agent** are documented here.

## [2.0.0] — 2026-05-07 — "Pakshiraj"

Major release: full **OpenClaw-inspired** agent architecture with file-based persistent memory, sub-agents, hooks, device nodes, and context compaction.

### Added — OpenClaw-style subsystems
- **`LongTermMemory` (MEMORY.md)** — file-based durable facts that survive restarts; appended under sections, searchable by substring
- **`DailyLog`** — per-day markdown activity log under `workspace/logs/YYYY-MM-DD.md`, auto-populated by gateway events
- **`SubAgentRunner`** — background isolated turns; sub-agents cannot nest; max 4 concurrent
- **`NodeRegistry`** — paired device nodes (macOS/iOS/Android/Linux/Windows/headless/browser) with capability advertisement and async invocation/wait
- **`HookRunner`** — event-driven hooks with match filters, error isolation, per-hook stats
- **`ContextCompactor`** — context-window summarization + low-importance pruning when budget exceeded

### New tools (+13 → 104 total)
- `longterm.read` / `longterm.append` / `longterm.search`
- `daily.log` / `daily.dates`
- `agent.spawn` / `agent.status` / `agent.list`
- `node.list` / `node.invoke`
- `skills.list` / `skills.read` (lazy metadata + on-demand body — OpenClaw-style)

### Stats
- **411 tests pass** across 37 suites
- **45 source files**, **37 test files**, **11,945 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [1.0.0] — 2026-05-06 — "Garuda"
First stable release. CI, docs, examples. 95 tools, 392 tests.

## [0.9.0] — "Shakti"
13 new tools, type-aware set ops, stricter email regex. 84 tools, 381 tests.

## [0.8.0] — "Tej"
13 new tools, fix `::` parsing bugs, validators added. 71 tools, 361 tests.

## [0.7.0] — "Vajra"
10 new tools, word-boundary SSE chunking, `/api/version`. 58 tools, 341 tests.

## [0.6.0]
9 new tools, `/live`, `/slo`, `/audit/export`, `/sessions/:id/forget`. 48 tools, 320 tests.

## [0.5.0]
12 new tools, tool quotas, webhook HMAC, conversation store, memory pinning/TTL. 39 tools, 298 tests.

## [0.4.0]
WebSocket server, tool cache, circuit breaker, Prometheus metrics, dashboard. 27 tools, 245 tests.

## [0.3.0]
Pairing flow, cron scheduler, plugin/skills loaders. 17 tools, 199 tests.

## [0.2.0]
Pluggable brain providers, audit log, rate limiter. 10 tools, 90 tests.
