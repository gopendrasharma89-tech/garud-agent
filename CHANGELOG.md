# Changelog

## [2.1.0] — 2026-05-09 — "Suparna"

Bug fixes + 7 new tools + enhanced subsystem APIs.

### Bug fixes
- `LongTermMemory.append` now correctly groups facts under existing sections (no duplicate `## section` headers); returns the fact line instead of full block
- `HookRunner.unregister` now cleans empty event lists (memory leak fix)
- `SubAgentRunner.list()` now accepts a limit parameter

### New subsystem methods
- `LongTermMemory.section(name)` — read a single section
- `LongTermMemory.clear()` — erase all facts (returns bytes removed)
- `LongTermMemory.factCount()` — count stored facts
- `SubAgentRunner.wait(jobId, timeoutMs)` — block until a job settles
- `SubAgentRunner.cancel(jobId)` — best-effort cancel pending jobs
- `HookRunner.size()` — total hook count
- `HookRunner.resetStats()` — clear counters without unregistering

### New tools (+7 → 111 total)
- `longterm.section`, `longterm.clear`, `longterm.stats`
- `agent.wait`, `agent.cancel`
- `node.register`, `node.unregister`

### Stats
- **421 tests pass** across 38 suites
- **45 source files**, **38 test files**, **12,231 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [2.0.0] — 2026-05-07 — "Pakshiraj"
OpenClaw-inspired architecture: LongTermMemory (MEMORY.md), DailyLog, SubAgentRunner, NodeRegistry, HookRunner, ContextCompactor. 104 tools, 411 tests.

## [1.0.0] — 2026-05-06 — "Garuda"
First stable release. CI, docs, examples. 95 tools, 392 tests.

## [0.9.0] — "Shakti"
Type-aware set ops, stricter email regex. 84 tools, 381 tests.

## [0.8.0] — "Tej"
13 new tools, fix `::` parsing bugs. 71 tools, 361 tests.

## [0.7.0] — "Vajra"
Word-boundary SSE chunking, `/api/version`. 58 tools, 341 tests.

## [0.6.0]
`/live`, `/slo`, `/audit/export`, `/sessions/:id/forget`. 48 tools, 320 tests.

## [0.5.0]
Tool quotas, webhook HMAC, conversation store. 39 tools, 298 tests.

## [0.4.0]
WebSocket, tool cache, circuit breaker, Prometheus metrics. 27 tools, 245 tests.

## [0.3.0]
Pairing, cron scheduler, plugin/skills loaders. 17 tools, 199 tests.

## [0.2.0]
Pluggable brain providers, audit log, rate limiter. 10 tools, 90 tests.
