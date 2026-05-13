# Changelog

## [2.3.0] — 2026-05-13 — "Aruna"

Bug fixes + 4 new tools + 6 new HTTP write endpoints + subsystem enhancements.

### Bug fixes
- `node.idle` `parseInt(input, 10) || 60_000` treated input `"0"` as falsy → defaulted to 60000; now explicit empty-string check
- `agent.prune`, `node.invocations` same falsy-fallback pattern fixed
- `active` identifier collision in `SubAgentRunner` (private counter vs. public method) — renamed counter to `activeCount`
- v2.2 exposed only GET endpoints for OpenClaw subsystems — v2.3 adds POST/DELETE

### New subsystem methods
- `LongTermMemory.history(limit)` — chronological fact list, newest first
- `SubAgentRunner.active()` — currently running or pending jobs
- `SubAgentRunner.jobDuration(id)` — runtime in ms
- `NodeRegistry.byCapability(cap)` — find nodes advertising capability

### New HTTP write endpoints (6)
- `POST /longterm/append` — append fact via HTTP
- `DELETE /longterm` — clear MEMORY.md
- `GET /longterm/history` — chronological fact list
- `POST /sub-agents/:id/cancel` — cancel pending job
- `POST /sub-agents/prune` — bulk-drop old jobs
- `POST /nodes/:id/invoke` — invoke capability (waits up to 30s)
- `DELETE /nodes/:id` — unregister node

### New tools (+4 → 121 total)
- `longterm.history`
- `agent.active`, `agent.duration`
- `node.byCapability`

### Stats
- **450 tests pass** across 40 suites in ~13 s
- **45 source files**, **40 test files**, **12,924 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [2.2.0] — 2026-05-11 — "Vinata"
OpenClaw subsystems exposed via HTTP + 6 new tools. 117 tools, 434 tests.

## [2.1.0] — 2026-05-09 — "Suparna"
Bug fixes + 7 new tools. 111 tools, 421 tests.

## [2.0.0] — 2026-05-07 — "Pakshiraj"
OpenClaw-inspired architecture: LongTermMemory, DailyLog, SubAgentRunner, NodeRegistry, HookRunner, ContextCompactor. 104 tools, 411 tests.

## [1.0.0] — 2026-05-06 — "Garuda"
First stable release. 95 tools, 392 tests.

## [0.9.0] — "Shakti"
Type-aware set ops, stricter validators. 84 tools, 381 tests.

## [0.8.0] — "Tej"
Fix `::` parsing bugs, validators. 71 tools, 361 tests.

## [0.7.0] — "Vajra"
Word-boundary SSE chunking, `/api/version`. 58 tools, 341 tests.

## [0.6.0]
`/live`, `/slo`, `/audit/export`. 48 tools, 320 tests.

## [0.5.0]
Quotas, webhook HMAC, conversation store. 39 tools, 298 tests.

## [0.4.0]
WebSocket, tool cache, circuit breaker, Prometheus metrics. 27 tools, 245 tests.

## [0.3.0]
Pairing, cron scheduler, plugins, skills. 17 tools, 199 tests.

## [0.2.0]
Pluggable brain providers, audit log, rate limiter. 10 tools, 90 tests.
