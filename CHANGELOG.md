# Changelog

## [3.8.0] — 2026-05-25 — "Nimbostratus"

**Architectural jump.** Garud was a closed system that only its own brain could drive. v3.8 opens it to the entire MCP ecosystem, gives it a real streaming surface, and \u2014 with the right opt-in env vars \u2014 lets it actually touch the host system and a browser.

### 🌐 MCP (Model Context Protocol) — full bidirectional support
- **Client** (`src/mcp/mcp-client.ts`) — spawn any stdio MCP server (file system, GitHub, Slack, custom Python tools, anything), and call its tools from Garud. JSON-RPC 2.0 framing, line-delimited, with request timeouts and clean shutdown.
- **Server** (`src/mcp/mcp-server.ts`) — `garud mcp` runs Garud as an MCP server over stdio so Claude Desktop, Cursor, ChatGPT, Gemini CLI, agent-framework — anything speaking MCP — can discover and call Garud's tools as if they were its own.
- Curated safe tool surface by default (`memory.*`, `longterm.*`, `daily.*`, `skills.*`, `embeddings.*`, `web.fetch`, `text.*`, `math.*`, `time.*`, `identity.*`, `agents.*`). Set `GARUD_MCP_EXPOSE_ALL=1` to expose every tool.
- HTTP management: `GET/POST/DELETE /mcp/clients`, `POST /mcp/clients/<id>/call`.

### 🌊 SSE chat streaming
- `src/streaming/sse.ts` — minimal Server-Sent Events writer with 15s keepalive.
- `POST /chat/stream` — body `{input, sessionId?, channel?}` returns `event: token` + `event: done` frames. Chat UIs feel like ChatGPT now.
- Even without a streaming-native brain, the final reply is chunked by word so the client experience is the same.

### 🖥️ System-access tool pack (opt-in)
`src/system/system-tools.ts` — six tools, **default-DENY**. Enable with `GARUD_SYSTEM_ACCESS=1`; further restrict with allowlists.
- `system.info` — platform/arch/cwd/memory
- `fs.read` / `fs.write` / `fs.list` — gated by `GARUD_FS_ALLOW=/path1:/path2`
- `shell.exec` — gated by `GARUD_EXEC_ALLOW=git:ls:echo` (allowlist first token of the command)
- `env.read` — env vars with `TOKEN|SECRET|KEY|PASSWORD` automatically masked to `***`

### 🌐 Browser-control tool pack (opt-in)
`src/browser/browser-tools.ts` — shells out to a chromium-compatible binary (`GARUD_BROWSER_BIN`, default `chromium`). Default-DENY; enable with `GARUD_BROWSER=1`.
- `browser.fetch` — JS-rendered DOM dump for a URL
- `browser.screenshot` — PNG screenshot at a given resolution
- `browser.info` — binary version probe

### 🔑 New env vars
- `GARUD_MCP_EXPOSE_ALL` — MCP server exposes every tool (default: curated subset)
- `GARUD_SYSTEM_ACCESS` — enables `system.*`, `fs.*`, `shell.exec`, `env.read`
- `GARUD_FS_ALLOW` — colon-separated directories the fs tools can touch
- `GARUD_EXEC_ALLOW` — colon-separated command names `shell.exec` can run
- `GARUD_BROWSER` — enables browser tools
- `GARUD_BROWSER_BIN` — override the chromium binary (e.g. `/usr/bin/google-chrome`)

### 🌐 New HTTP endpoints (+5)
- `POST /chat/stream` (SSE)
- `GET /mcp/clients`, `POST /mcp/clients`, `DELETE /mcp/clients/<id>`, `POST /mcp/clients/<id>/call`

### 🆕 New CLI command
- `garud mcp` — run as MCP server over stdio

### 📊 Stats
- **668 tests pass** across 57 suites in ~22 s (+9 v3.8 including a real MCP client/server round-trip)
- **78 source files**, **57 test files**, **20,586 LoC**
- 165 base built-in tools + 6 system + 3 browser = 174 tools when env enabled
- ~82 HTTP endpoints, zero runtime dependencies, strict TS

## [3.7.0] — 2026-05-24 — "Altocumulus"

Security & hygiene release: workspace download is now **gated by signed URLs**, agents.md drives **persona routing**, and the skill library has a real **pruning policy** so a long-running agent doesn't accumulate one-shot junk forever.

### 🐛 Bug fixes
- `verifyUrlToken()` returned `{ ok: false }` without a reason when the MAC didn't match. Now correctly surfaces `reason: 'mismatch'`.
- `AutoSkillExtractor` extracted on *every* non-trivial reply, including 3-character greetings and `Thanks!` responses. New v3.7 floor: input ≥ 20 chars, reply ≥ 60 chars, and conversational replies are explicitly rejected.
- `AGENTS.md` was parsed but personas were not exposed through any API. Now reachable via `GET /agents`, `GET /agents/<slug>`, and via the `agents.list` / `agents.find` tools.
- `SkillLibrary.listSlugs()` did a full directory scan on every call. New in-memory slug cache, invalidated on `write`/`remove`/`extract`.

### 🔐 Signed URLs
- `src/auth/signed-url.ts` — `signUrlToken(secret, path, exp)` and `verifyUrlToken()` using constant-time HMAC-SHA256. Token format: `<hex-mac>.<exp-unix-seconds>`.
- `GET /workspace.tgz` now requires `?token=` when `GARUD_WORKSPACE_SIGN_SECRET` is set (closes a real data-leak hole — anyone with the URL could pull the workspace).
- `POST /workspace.tgz/sign` mints a short-lived signed URL. TTL clamped to `[30, 3600]` seconds.

### 🎭 AGENTS.md persona routing
- `src/workspace/agents-parser.ts` — parses the existing AGENTS.md format into structured `AgentPersona[]` with `{slug, persona, tools, trustDefault, notes}`.
- `findPersona(personas, slug)` falls back to `default` when the requested persona is missing.
- Invalid trust levels (e.g. `superuser`) are silently rejected.

### 🧹 Skill pruning
- `SkillLibrary.prune({ minSuccessCount, maxAgeMs, dryRun })` — default policy: delete skills where `successCount < 2` AND `lastUsed > 30 days ago`. Both must hold, so a 1-shot from yesterday survives but a 1-shot from last month doesn't.
- `dryRun: true` reports what would be deleted without touching disk.

### ✨ New built-in tools (+3 → 165 total)
`agents.list` · `agents.find` · `skills.prune`

### 🌐 New HTTP endpoints (+5)
- `GET /agents` · `GET /agents/<slug>`
- `POST /workspace.tgz/sign`
- `POST /skills/prune`
- (Existing `GET /workspace.tgz` now gated by signed URL when secret set)

### 🔑 New env var
- `GARUD_WORKSPACE_SIGN_SECRET` — enables signed-URL gating on `/workspace.tgz`

### 📊 Stats
- **659 tests pass** across 56 suites in ~22 s (+22 over v3.6)
- **73 source files**, **56 test files**, **19,660 LoC**
- 165 built-in tools, ~77 HTTP endpoints, zero runtime dependencies, strict TS

## [3.6.0] — 2026-05-23 — "Nimbus"

The v3.5 release added Hermes-style **structure**; v3.6 makes it **actually do something**: skills are auto-extracted from successful agent replies, HEARTBEAT.md rules fire on real timers, and the CLI `doctor` matches the HTTP report.

### 🐛 Bug fixes
- `parseHeartbeatSchedule('Send the daily report daily at 8:00')` was matching the first `daily` in "daily report" and defaulting to 09:00. Split into `DAILY_AT_RE` (priority) and `DAILY_BARE_RE` (fallback).
- CLI `doctor` was hand-rolled and out of sync with `runDoctor()` over HTTP. Both now share the same structured report (and support `--json=true`).
- `runDoctor` flagged every `GARUD_*_SECRET` env var as a leak. They're the *expected* configuration; now reported as `env.garud-secrets / ok`.
- `Heartbeat.md` rules were parsed but never executed. New `HeartbeatScheduler` actually runs them.
- `AutoCostBrain` didn't see the *learned* reply; v3.6 puts `AutoSkillExtractor` *inside* `AutoCostBrain` so cost accounting captures the final reply size and learning failures can't break cost.

### 🧠 New: Hermes-style auto-learning loop
- `src/skills/auto-skill-extractor.ts` — BrainProvider decorator. After every `compose()` returning a non-trivial, error-free reply, fire-and-forgets a `SkillLibrary.extract()` call. Repeated similar prompts bump `successCount` rather than spamming new skills.
- Wired in `bootstrap()` between the raw brain and `AutoCostBrain`.

### ⏰ New: HEARTBEAT.md → real timers
- `src/heartbeat/heartbeat-scheduler.ts` — parses rules into one of three schedule kinds:
  - `every Ns|m|h|d|w` → fixed interval
  - `daily at HH:MM` (12h or 24h) → daily fire
  - `weekly` / `once a week` → 7-day interval
- Unscheduled rules are still surfaced via `GET /heartbeat/scheduled` so the brain can interpret prose at runtime.
- Each fire appends a `system` entry to the daily log via existing `DailyLog.append()`.
- All timers `unref()`-ed so they never block process exit.

### 📦 New: workspace tarball download
- `GET /workspace.tgz` returns a gzipped tar of the workspace dir.
- Pure-Node tar writer (ustar format) + `zlib.gzipSync` — still zero deps.
- Skips `node_modules`, `.git`, `dist`, `.tmp`. Caps: 5 MiB per file, 32 MiB total archive.

### 🩺 CLI `garud doctor` upgrade
- Now uses `runDoctor()` so output matches the HTTP `/doctor` endpoint exactly.
- ANSI-coloured severity tags (`OK`, `INFO`, `WARN`, `ERROR`).
- `garud doctor --json=true` for machine-readable output.

### 🌐 New HTTP endpoints (+2)
- `GET /heartbeat/scheduled` — active scheduled rules with parsed `kind` / `everyMs` / `at`
- `GET /workspace.tgz` — gzipped tar of the workspace directory

### 📊 Stats
- **637 tests pass** across 54 suites in ~21 s (+14 over v3.5)
- **71 source files**, **54 test files**, **19,073 LoC**
- 162 built-in tools, ~72 HTTP endpoints, zero runtime dependencies, strict TS

## [3.5.0] — 2026-05-22 — "Cumulus"

**OpenClaw / Hermes parity release.** After research into OpenClaw's workspace files (SOUL/IDENTITY/AGENTS/USER/TOOLS/HEARTBEAT/MEMORY) and Hermes Agent's learning loop, this release closes the structural gap with both projects while staying zero-dependency.

### 🔬 What we matched

| Feature | OpenClaw / Hermes | Garud v3.4 | Garud v3.5 |
|---|---|---|---|
| SOUL.md (personality) | ✅ | ✅ | ✅ |
| AGENTS.md (operating manual) | ✅ | ✅ | ✅ |
| USER.md (user profile) | ✅ | ✅ | ✅ |
| MEMORY.md (long-term) | ✅ | ✅ | ✅ |
| **IDENTITY.md** (metadata card) | ✅ | ❌ | ✅ |
| **TOOLS.md** (auto-catalog) | ✅ | ❌ | ✅ |
| **HEARTBEAT.md** (declarative cron) | ✅ | ❌ | ✅ |
| **Lazy-loaded memory topics** | ✅ Claude Code | ❌ | ✅ |
| **Skill learning loop** | ✅ Hermes | ❌ | ✅ |
| **`doctor` health audit** | ✅ OpenClaw | ❌ | ✅ |
| **Slack v0 signature** | ✅ | ⚠️ generic HMAC | ✅ |
| **Discord Ed25519** | ✅ | ⚠️ HMAC (wrong) | ✅ |

### 🐛 Bug fixes
- `/channel/slack` was using GitHub-style `x-hub-signature-256` HMAC, but Slack actually uses the v0 scheme: `v0=hmac(secret, "v0:ts:body")` with a 5-minute timestamp window. Replaced with `verifySlackV0()`.
- `/channel/discord` was using HMAC, but **Discord requires Ed25519** verification over `timestamp+body` against the application's public key. Replaced with `verifyDiscordEd25519()` using Node's built-in `crypto.verify` (still zero deps).
- `WorkspaceFiles.snapshot()` returned an incomplete view (missing IDENTITY + heartbeat rule count). Fixed.

### 🆕 New subsystems
- **`src/memory/memory-index.ts`** — Claude-Code-style MEMORY.md router. 200-line index cap, lazy-loaded `workspace/memory/<topic>.md` topic files, 256 KiB per-topic cap.
- **`src/skills/skill-library.ts`** — Hermes-style learning loop. `extract({input,output,success})` captures successful tasks as reusable skills; `findRelevant(query, k)` scores via token overlap × `log(1+successCount)`. Skills are plain markdown with a YAML header.
- **`src/doctor/doctor.ts`** — Structured health/config audit. Surfaces missing workspace files, empty policy rules, guest-allow on mutating ops, missing channel HMAC secrets, GitHub PAT-like env vars, empty tool registry.
- **`src/channels/hmac-verify.ts`** extended with `verifySlackV0()` and `verifyDiscordEd25519()`.

### 📝 New workspace files (auto-seeded on first read)
- `IDENTITY.md` — metadata card (name, id, role, version, codename, homepage, license). 32 KiB cap.
- `TOOLS.md` — auto-generated tool catalog. Regenerate via `POST /tools.md/regenerate`. 256 KiB cap.
- `HEARTBEAT.md` — declarative recurring rules grouped under `## section` headings. Parsed via `parseHeartbeatRules()`. 64 KiB cap.

### ✨ New built-in tools (+8 → 162 total)
`memory.topic` · `memory.topics` · `memory.topic.write` · `skills.extract` · `skills.find` · `skills.size` · `identity.read` · `heartbeat.rules`

### 🌐 New HTTP endpoints (+11)
- `GET /identity` · `POST /identity`
- `GET /tools.md` · `POST /tools.md/regenerate`
- `GET /heartbeat/rules`
- `GET /memory/index` · `GET /memory/topics`
- `GET /memory/topic/<name>` · `POST /memory/topic/<name>`
- `GET /skills` · `GET /skills/search?q=…&k=…` · `POST /skills/extract` · `GET /skills/<slug>`
- `GET /doctor`

### 📊 Stats
- **623 tests pass** across 53 suites in ~18 s (+27 over v3.4)
- **68 source files**, **53 test files**, **18,596 LoC**
- 162 built-in tools, ~70 HTTP endpoints, zero runtime dependencies, strict TS

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
