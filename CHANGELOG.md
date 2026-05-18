# Changelog

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
