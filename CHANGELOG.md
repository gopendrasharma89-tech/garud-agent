# Changelog

## [2.2.0] — 2026-05-11 — "Vinata"

OpenClaw subsystems now fully exposed via HTTP + 6 new tools + stats APIs.

### Bug fixes
- `node.register` validation tightened (requires {name, platform, capabilities[]})
- `LongTermMemory` lacked section-listing API
- v2.0 OpenClaw subsystems weren't reachable over HTTP (only via tools/CLI)

### New subsystem methods
- `LongTermMemory.sections()` — list section names in file order
- `SubAgentRunner.stats()` — counters by status (pending/running/done/failed)
- `NodeRegistry.idle(ms)` — nodes not seen recently
- `NodeRegistry.stats()` — node + invocation counters

### New HTTP endpoints (7)
- `GET  /longterm` — full MEMORY.md state
- `GET  /longterm/stats` — bytes + facts + section count
- `GET  /longterm/section/:name` — single section body
- `GET  /sub-agents` — list jobs + status counters
- `GET  /sub-agents/:id` — job detail
- `GET  /nodes` — paired devices + stats
- `GET  /nodes/invocations` — recent invocation log
- `GET  /hooks` — registered hooks with fire/error counters

### New tools (+6 → 117 total)
- `longterm.sections`
- `agent.stats`, `agent.prune`
- `node.stats`, `node.invocations`, `node.idle`

### Stats
- **434 tests pass** across 39 suites in ~13 s
- **45 source files**, **39 test files**, **12,571 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [2.1.0] — 2026-05-09 — "Suparna"
Bug fixes + 7 new tools + enhanced subsystem APIs. 111 tools, 421 tests.

## [2.0.0] — 2026-05-07 — "Pakshiraj"
OpenClaw-inspired architecture: LongTermMemory, DailyLog, SubAgentRunner, NodeRegistry, HookRunner, ContextCompactor. 104 tools, 411 tests.

## [1.0.0] — 2026-05-06 — "Garuda"
First stable release. 95 tools, 392 tests.

## [0.9.0] — "Shakti"
Type-aware set ops, stricter validators. 84 tools, 381 tests.

## [0.8.0] — "Tej"
Fix `::` parsing bugs, validators added. 71 tools, 361 tests.

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
