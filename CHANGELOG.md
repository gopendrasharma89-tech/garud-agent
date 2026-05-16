# Changelog

## [2.6.0] — 2026-05-16 — "Rajasinha"

Bug fixes + 5 new tools + 3 new HTTP endpoints + comprehensive repository polish.

### Bug fixes
- `LongTermMemory.replace` had no size cap; now enforces 5 MiB limit and throws on overflow
- `POST /longterm/replace` accepted unbounded payloads; now caps at 6 MiB and returns 413 on overflow
- Audit log had no HTTP introspection endpoint despite being a key debugging surface

### New subsystem features
- `LongTermMemory.replace` — 5 MiB size cap with descriptive error
- `ContextCompactor` wired into `BuiltinToolDeps` for tool-driven planning
- In-memory audit sink exposed to tools via `BuiltinToolDeps.auditSink`

### New HTTP endpoints (2)
- `GET /audit/kinds` — distinct kinds present in the audit log
- `GET /audit/count` — counter per audit kind
- `POST /longterm/replace` — now returns 413 with clear error on oversized body

### New tools (+5 → 133 total)
- `skills.match` — find skills by token overlap with input
- `audit.kinds` — list distinct audit kinds
- `audit.count` — counter per kind
- `compactor.plan` — dry-run compaction plan
- `compactor.size` — character size of a turn array

### Repository improvements
- **`SECURITY.md`** — supported versions, vulnerability reporting, hardening guidance
- **`docs/architecture.md`** — architecture diagram, OpenClaw subsystem catalog, persistence layout
- **`examples/javascript-client.md`** — minimal HTTP, SSE, WebSocket, long-term, audit replay, signed webhook recipes
- **CI workflow** — expanded with strict-TS lint, CLI smoke test, repository quality gate
- **GitHub repo** — topics + enriched description (set via API)

### Stats
- **488 tests pass** across 43 suites in ~14 s
- **45 source files**, **43 test files**, **13,754 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [2.5.0] — "Jatayu" · 128 tools · 479 tests
Uncapped `byDate`, `daily.latest`, `longterm.replace`. 3 new tools, 2 new HTTP endpoints.

## [2.4.0] — "Sampati" · 125 tools · 465 tests
Daily-log endpoints + sort stability fix.

## [2.3.0] — "Aruna" · 121 tools · 450 tests
HTTP write endpoints + falsy-fallback fix.

## [2.2.0] — "Vinata" · 117 tools · 434 tests
OpenClaw subsystems exposed via HTTP.

## [2.1.0] — "Suparna" · 111 tools · 421 tests
Bug fixes + enhanced subsystem APIs.

## [2.0.0] — "Pakshiraj" · 104 tools · 411 tests
OpenClaw-inspired architecture: LongTermMemory, DailyLog, SubAgentRunner, NodeRegistry, HookRunner, ContextCompactor.

## [1.0.0] — "Garuda" · 95 tools · 392 tests
First stable release with CI, docs, examples.

## [0.9.0] — "Shakti" · 84 tools · 381 tests
Type-aware set ops, stricter validators.

## [0.8.0] — "Tej" · 71 tools · 361 tests
Fix `::` parsing bugs, validators added.

## [0.7.0] — "Vajra" · 58 tools · 341 tests
Word-boundary SSE chunking, `/api/version`.

## [0.6.0] · 48 tools · 320 tests
`/live`, `/slo`, `/audit/export`, `/sessions/:id/forget`.

## [0.5.0] · 39 tools · 298 tests
Quotas, webhook HMAC, conversation store, memory pinning/TTL.

## [0.4.0] · 27 tools · 245 tests
WebSocket, tool cache, circuit breaker, Prometheus metrics, dashboard.

## [0.3.0] · 17 tools · 199 tests
Pairing, cron scheduler, plugin/skills loaders.

## [0.2.0] · 10 tools · 90 tests
Pluggable brain providers, audit log, rate limiter.
