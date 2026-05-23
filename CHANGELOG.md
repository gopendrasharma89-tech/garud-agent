# Changelog

## [3.4.0] — 2026-05-21 — "Stratus"

Hardening release: **HMAC for channels**, **HTTP for graph/crew**, **auto cost tracking on the brain**, plus 6 new tools.

### 🐛 Bug fixes
- `AgentGraph` had no clean way to short-circuit from inside a node. Nodes can now write `__done: true` into the state to terminate the run cleanly (status remains `completed`).
- Channel endpoints (`/channel/whatsapp|telegram|discord|slack`) accepted any payload without authentication, even when the user had a shared secret with the upstream platform. They now read the raw body once, verify HMAC if a secret is configured, then parse — closing a real security hole.
- `OpenAiBrain` never recorded into `CostTracker`, so the cost dashboard stayed at zero in real deployments. Added `AutoCostBrain` decorator that wraps any `BrainProvider` and records `plan` + `compose` token estimates automatically; `bootstrap()` now wires it transparently.

### 🔐 New: HMAC channel security
- `src/channels/hmac-verify.ts` — constant-time `verifyHmac` and `signHmac` with sha1/sha256/sha512 support, length-mismatch rejection, optional body-size cap.
- `ServerDeps.channelSecrets` lets you configure per-channel secrets; `index.ts` reads `GARUD_WHATSAPP_SECRET`, `GARUD_TELEGRAM_SECRET`, `GARUD_DISCORD_SECRET`, `GARUD_SLACK_SECRET` from the environment.
- Accepts both `x-hub-signature-256: sha256=<hex>` (GitHub/Slack-style) and `x-garud-signature: <hex>` (raw) headers.
- When no secret is configured the endpoint remains open (backwards-compatible).

### 💸 New: AutoCostBrain
- `src/brain/auto-cost-brain.ts` — transparent decorator. Records `tokensIn`/`tokensOut`/`toolCalls` and labels `{ brain, op }` on every `plan`/`compose`.
- Token estimator: deterministic 1-token-per-4-chars when the underlying provider doesn't surface real usage.

### ✨ New built-in tools (+6 → 154 total)
- `graph.run` — execute a declarative AgentGraph spec via JSON
- `crew.run` — run a static-reply Crew via JSON
- `cost.recent` — list recent cost records with optional `sessionId` filter
- `trace.size` — Tracer counts (active in-flight + finished)
- `hmac.sign` — compute HMAC for outbound verification / tests
- `hmac.verify` — verify HMAC, returns `{ ok, reason? }`

### 🌐 New HTTP endpoints (+3)
- `POST /graph/run` — execute a JSON graph spec (max 64 KiB, capped at 64 steps)
- `POST /crew/run` — execute a static-reply crew spec (max 8 rounds)
- `GET /trace/size` — active + recent span counts

### 📊 Stats
- **596 tests pass** across 51 suites in ~17s
- **65 source files**, **51 test files**, **17,379 lines of TypeScript**
- 154 built-in tools, ~60 HTTP endpoints, zero runtime dependencies, strict TS

## [3.3.0] — 2026-05-20 — "Cirrus"

Polish release that **wires the eight v3.2 subsystems into the rest of the system**: built-in tools, HTTP endpoints, and on-disk persistence. Garud is now the only zero-dependency agent gateway that ships LangGraph-style graphs, CrewAI multi-agent, TF-IDF embeddings, cost tracking, OTLP tracing, reflection, planning *and* exposes them all over HTTP.

### 🐛 Bug fixes
- `EmbeddingStore` had no way to snapshot its docs — added `all()` so persistence layers can save it.
- `BuiltinToolDeps` was missing slots for the v3.2 subsystems, so they were unreachable from CLI tools. They are now first-class deps.
- `bootstrap()` did not wire `embeddings`, `costTracker`, `tracer`, `reflector`, or `planner` into the tool registry; v3.2 subsystems were effectively dark. Now wired with auto-restore for embeddings from `workspace/embeddings.jsonl`.
- `index.ts` did not forward the new subsystems to `createServer`, so the HTTP layer could not serve them. Forwarded now.
- Server version-aware tests were pinned to "Stormwing/3.2.0"; bumped to "Cirrus/3.3.0".

### ✨ New built-in tools (+8 → 148 total)
- `embeddings.add` — add a doc; auto-persists to `workspace/embeddings.jsonl`
- `embeddings.search` — top-K TF-IDF semantic search
- `embeddings.size` — count indexed docs
- `cost.record` — record token/tool-call usage with labels
- `cost.summary` — aggregate cost summary with optional filter
- `trace.spans` — list recent finished spans (OTLP-compatible)
- `reflect.revise` — run a heuristic self-critique pass
- `plan.create` — heuristic plan decomposition with tool hints

### 🌐 New HTTP endpoints (+5)
- `GET  /embeddings` → `{ size }`
- `POST /embeddings/add` → adds `{id,text,meta?}`, returns new size (256 KiB cap)
- `POST /embeddings/search` → top-K results for `{query,k?}`
- `GET  /cost/summary?sessionId=<id>` → aggregated cost
- `GET  /trace/spans?limit=N` → recent spans (limit clamped to [1,500])

### 💾 Persistence
- Embeddings now survive process restarts via JSONL on disk at `workspace/embeddings.jsonl` (atomic temp+rename).

### 📊 Stats
- **576 tests pass** across 49 suites in ~17s
- **63 source files**, **49 test files**, **16,816 lines of TypeScript**
- 148 built-in tools, ~55 HTTP endpoints, zero runtime dependencies, strict TS

## [3.2.0] — 2026-05-19 — "Stormwing"

Major release: **8 new subsystems** that put Garud on par with LangGraph, CrewAI, AutoGen, and LangChain — while keeping zero runtime dependencies.

### Eight new subsystems

| Module | Inspired by | What it does |
|---|---|---|
| `src/graph/agent-graph.ts` | LangGraph | DAG-based agent orchestration with conditional edges, state passing, loop bounds |
| `src/reflection/reflector.ts` | Reflection / self-critique loops | Critique-and-revise cycle with a pluggable strategy |
| `src/planning/planner.ts` | Plan-and-execute | Heuristic task decomposition with tool-hint inference |
| `src/embeddings/embedding-store.ts` | Vector databases | TF-IDF + cosine similarity semantic search (no API required) |
| `src/cost/cost-tracker.ts` | LangChain callbacks | Token / tool-call accounting with USD pricing |
| `src/tracing/span.ts` | OpenTelemetry | Trace/span model compatible with OTLP-JSON |
| `src/retry/retry-policy.ts` | Resilience4j | Exponential backoff with jitter + retryable predicate |
| `src/crew/crew.ts` | CrewAI | Multi-agent collaboration with supervisor / round-robin patterns |

### Highlights

- **AgentGraph** — define an agent flow as nodes + edges with conditional routing, run until `END` or `maxSteps`. Cycles allowed and bounded.
- **Reflector** — generic critique-and-revise loop; `textHeuristicReflector` ships as a deterministic baseline.
- **HeuristicPlanner** — splits goals on cue words and infers tool hints from natural-language verbs.
- **EmbeddingStore** — TF-IDF based local semantic search; swap in any vectorizer (e.g. OpenAI embeddings) via `setVectorizer`.
- **CostTracker** — per-session, per-request, per-label cost aggregation with configurable price tables.
- **Tracer** — span model with traceId / parentSpanId / events / attributes; OTLP-compatible exporters.
- **withRetry** — exponential backoff with optional jitter, retryable predicate, on-retry hook.
- **Crew** — multi-agent collaboration; supervisor function decides who handles next sub-task.

### Stats
- **564 tests pass** across 47 suites in ~16 s
- **61 source files**, **47 test files**, **16,242 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies


## [3.1.0] — 2026-05-18 — "Talon"

Bug fixes + Slack adapter + outbound channel senders + session compaction endpoint + NO_COLOR support.

### Bug fixes
- `mascot()` now honors the `NO_COLOR` environment variable (https://no-color.org)
- `Heartbeat` listeners now fire in parallel via `Promise.allSettled` — slow listeners can no longer block fast ones
- `parseTelegram` previously dropped non-text messages silently; now surfaces photos/voice/documents/captions as descriptive placeholders with `mediaType` metadata
- `parseDiscord` slash commands lost option names; now formatted as `/name key=value key2=value2` and adds `commandName` metadata

### New: Slack channel adapter
- `POST /channel/slack` accepts Slack Events API payloads
- Handles `url_verification` challenge with plain-text response (Slack-compatible)
- Filters bot messages and subtype joins to avoid loops
- Adapter at `src/channels/adapters/slack-adapter.ts`

### New: Outbound channel senders
- `src/channels/adapters/outbound.ts` exports `sendWhatsApp`, `sendTelegram`, `sendDiscord`, `sendSlack`
- All zero-dep, use Node's built-in `fetch`
- Caller supplies the platform's API token / webhook URL

### New: Session compaction endpoint
- `POST /sessions/:id/compact` — runs `ContextCompactor.plan()` on the session's conversation history and returns `{ before, after, removed, summary, flushed }`
- 404 for unknown session, 503 if conversation store disabled

### Stats
- **533 tests pass** across 46 suites in ~16 s
- **53 source files**, **46 test files**, **15,150 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies


## [3.0.0] — 2026-05-17 — "Skyforge"

Major release: working channel adapters (WhatsApp, Telegram, Discord), OpenClaw-style workspace files (SOUL.md / USER.md / AGENTS.md), heartbeat subsystem, mascot, and globalized branding.

### Channel adapters (3 new)
- **WhatsApp Cloud API** — `POST /channel/whatsapp` accepts Meta webhook payloads
- **Telegram Bot API** — `POST /channel/telegram` accepts updates from `setWebhook`
- **Discord interactions + webhook** — `POST /channel/discord` handles slash commands, button callbacks, and webhook messages (with auto PING/PONG)

All three are zero-dependency — they parse the platform's raw JSON without any external SDK.

### OpenClaw-style workspace files
- **`SOUL.md`** — agent personality, voice, boundaries (default scaffold provided)
- **`USER.md`** — per-user profile facts under `workspace/users/<userId>.md`
- **`AGENTS.md`** — declarative agent roster (default + scribe + planner + ops)
- **`WorkspaceFiles`** subsystem with size caps (256 KiB SOUL/AGENTS, 64 KiB USER) and userId sanitization

### Heartbeat subsystem
- **`Heartbeat`** — periodic self-check (default 60s) emitting `{uptimeSec, rssBytes, heapUsedBytes, pendingSubAgents, notes}`
- Listeners + probes API for proactive behavior
- `start()`/`stop()` idempotent with `unref()` so it never blocks process exit
- HTTP: `GET /heartbeat`, `POST /heartbeat/beat`

### Mascot
- ASCII-art falcon "Skyforge" with optional ANSI color (auto-detects TTY)
- `garud mascot` and `garud --help` show the mascot
- `mascot()` and `mascotInline()` exports

### Globalized branding
- Codename system shifted from Sanskrit bird names (Garuda, Pakshiraj, Suparna, Vinata, Aruna, Sampati, Jatayu, Rajasinha) to globally-neutral "Skyforge" for v3.0 and onward
- Keeps the project name **Garud** (the falcon identity) — universal mythological bird across multiple cultures
- Docs/comments rewritten for international readability

### New HTTP endpoints (10)
- `POST /channel/whatsapp`, `/channel/telegram`, `/channel/discord`
- `GET /heartbeat`, `POST /heartbeat/beat`
- `GET /soul`, `POST /soul`
- `GET /agents.md`
- `GET /user/:userId`, `POST /user/:userId`, `GET /users`

### New tools (+7 → 140 total)
- `soul.read`, `soul.write`
- `user.read`, `user.write`
- `agents.read`
- `heartbeat.status`, `heartbeat.beat`

### Stats
- **516 tests pass** across 45 suites in ~14 s
- **51 source files**, **45 test files**, **14,698 lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [2.6.0] — "Rajasinha" · 133 tools · 488 tests
Audit endpoints, repository polish (SECURITY.md, docs/architecture.md, examples/javascript-client.md), size caps.

## [2.5.0] — "Jatayu" · 128 tools · 479 tests
Uncapped `byDate`, `daily.latest`, `longterm.replace`.

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

## [0.2.0 — 0.9.0]
Foundational layers: brain providers, memory store, audit log, rate limiter, WebSocket, cache, circuit breaker, Prometheus metrics, dashboard, pairing, scheduler, plugins, skills, quotas, webhook HMAC, conversation store.
