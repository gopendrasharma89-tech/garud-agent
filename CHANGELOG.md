# Changelog

## [2.4.0] — 2026-05-14 — "Sampati"

Bug fixes + 4 new tools + 7 new HTTP endpoints + subsystem enhancements.

### Bug fixes
- `LongTermMemory.history` reversed insertion order incorrectly; now stable-sorts by `(date desc, insertion-order desc)`
- `SubAgentRunner.jobDuration` returned `0` for both missing and pending jobs (ambiguous); now returns `-1` for missing
- `POST /nodes/:id/invoke` allowed negative `timeoutMs`; now validated `>= 0` and clamped to `[1, 30000]`
- `POST /sub-agents/prune` accepted negative `olderThanMs`; now rejected with 400

### New subsystem methods
- `LongTermMemory.byDate(date)` — facts logged on a specific YYYY-MM-DD
- `DailyLog.summary()` — `{ dates, bytes }` aggregate stats
- `HookRunner.byEvent(event)` — hooks registered for a specific event with stats

### New HTTP endpoints (7)
- `GET /longterm/by-date/:date` — facts on a specific date
- `GET /daily` — today's (or specified) daily-log markdown
- `GET /daily/dates` — sorted list of available log dates
- `GET /daily/summary` — aggregate `{ dates, bytes }`
- `GET /hooks/event/:event` — hooks for a specific event with fire/error counters
- `POST /sub-agents/:id/cancel` now also returns `duration`
- `POST /nodes/:id/invoke` / `POST /sub-agents/prune` validate numeric inputs

### New tools (+4 → 125 total)
- `longterm.byDate`
- `daily.summary`
- `hooks.byEvent`, `hooks.size`

### Stats
- **465 tests pass** across 41 suites in ~13 s
- **45 source files**, **41 test files**, **13,246 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [2.3.0] — 2026-05-13 — "Aruna"
HTTP write endpoints + 4 new tools + falsy-fallback fix. 121 tools, 450 tests.

## [2.2.0] — 2026-05-11 — "Vinata"
OpenClaw subsystems exposed via HTTP + 6 new tools. 117 tools, 434 tests.

## [2.1.0] — 2026-05-09 — "Suparna"
Bug fixes + 7 new tools + enhanced subsystem APIs. 111 tools, 421 tests.

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
