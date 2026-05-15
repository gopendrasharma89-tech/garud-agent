# Changelog

## [2.5.0] — 2026-05-15 — "Jatayu"

Bug fixes + 3 new tools + 3 new HTTP endpoints + subsystem enhancements.

### Bug fixes
- `LongTermMemory.byDate` was capped at 1000 facts (via internal `history(1000)` call); now iterates the full body so all matching facts are returned
- `DailyLog.summary` didn't surface the most-recent date; now includes optional `latest` field

### New subsystem methods
- `LongTermMemory.byDate(date)` — uncapped iteration of facts on a specific date
- `DailyLog.summary().latest` — most recent date present
- `DailyLog.latest(n)` — combined markdown of last N daily logs with date headers
- `ContextCompactor.applyTo(turns)` — returns compacted turns directly (no metadata)

### New HTTP endpoints (2)
- `GET /daily/latest?n=N` — combined recent daily logs
- `POST /longterm/replace` — overwrite MEMORY.md body atomically

### New tools (+3 → 128 total)
- `daily.latest`
- `longterm.replace`
- `agent.pending`

### Stats
- **479 tests pass** across 42 suites in ~16 s
- **45 source files**, **42 test files**, **13,515 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [2.4.0] — 2026-05-14 — "Sampati"
Daily-log endpoints + sort stability fix. 125 tools, 465 tests.

## [2.3.0] — 2026-05-13 — "Aruna"
HTTP write endpoints + falsy-fallback fix. 121 tools, 450 tests.

## [2.2.0] — 2026-05-11 — "Vinata"
OpenClaw subsystems exposed via HTTP. 117 tools, 434 tests.

## [2.1.0] — 2026-05-09 — "Suparna"
Bug fixes + enhanced subsystem APIs. 111 tools, 421 tests.

## [2.0.0] — 2026-05-07 — "Pakshiraj"
OpenClaw-inspired architecture: LongTermMemory, DailyLog, SubAgentRunner, NodeRegistry, HookRunner, ContextCompactor. 104 tools, 411 tests.

## [1.0.0] — 2026-05-06 — "Garuda"
First stable release. 95 tools, 392 tests.

## [0.9.0] — "Shakti"
Type-aware set ops, stricter validators. 84 tools, 381 tests.

## [0.8.0] — "Tej"
Fix `::` parsing bugs, validators. 71 tools, 361 tests.

## [0.7.0] — "Vajra"
Word-boundary SSE chunking. 58 tools, 341 tests.

## [0.6.0]
`/live`, `/slo`, `/audit/export`. 48 tools, 320 tests.

## [0.5.0]
Quotas, webhook HMAC. 39 tools, 298 tests.

## [0.4.0]
WebSocket, tool cache, Prometheus metrics. 27 tools, 245 tests.

## [0.3.0]
Pairing, scheduler, plugins. 17 tools, 199 tests.

## [0.2.0]
Pluggable brain, audit log, rate limiter. 10 tools, 90 tests.
