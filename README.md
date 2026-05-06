# 🦅 Garud Agent

[![CI](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/gopendrasharma89-tech/garud-agent/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-392%20passing-brightgreen)](https://github.com/gopendrasharma89-tech/garud-agent/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Tools](https://img.shields.io/badge/tools-95-purple)]()
[![Deps](https://img.shields.io/badge/runtime%20deps-0-success)]()

A **local-first**, **policy-aware**, **multi-channel** agent gateway with pluggable LLM brains, persistent memory, 95 built-in tools, scheduler, signed webhooks, WebSocket, dashboard, Prometheus metrics, and audit replay — all in **strict TypeScript with zero runtime dependencies**.

> **Version:** 1.0.0 "Garuda" · Released 2026-05-06

## ✨ Highlights

- 🧠 **Pluggable LLM brain** — `deterministic` (built-in) or any OpenAI-compatible endpoint
- 🛠️ **95 built-in tools** — memory, math, text, json, crypto, time, geo, validate, color, array, uuid, ...
- 🌐 **20+ HTTP endpoints** — REST + Server-Sent Events streaming
- 🔌 **WebSocket server** with auth, ping/pong, broadcast
- 🔐 **Signed webhooks** (HMAC-SHA256) with constant-time verification
- 📊 **Built-in dashboard** at `/` and **Prometheus metrics** at `/metrics`
- 🧾 **Full audit log** with replay endpoint
- ⏰ **Cron-style scheduler** for recurring messages
- 🔁 **Tool result cache** + **circuit breaker** + **rate limiter** + **per-trust quotas**
- 💾 **Persistent memory** with pinning, TTL, dedup, and importance scoring
- 📜 **Skills hot-reload** — drop a markdown file, it becomes a tool
- 🪶 **Zero runtime dependencies**, **strict TypeScript**, **392 tests** in 13 s

## 🚀 Quick Start

```bash
git clone https://github.com/gopendrasharma89-tech/garud-agent.git
cd garud-agent
npm install
npm run build
npm test                    # 392 tests pass
npm start                   # boot HTTP server on :3010
```

CLI:
```bash
npm run cli help            # list commands
npm run cli version
npm run cli tools           # list all 95 tools
npm run cli doctor          # health check
npm run cli repl            # interactive REPL
```

## 🌐 HTTP API (sample)

```bash
# health
curl localhost:3010/health
# send a message
curl -X POST localhost:3010/message \
     -H "content-type: application/json" \
     -d '{"channel":"http","userId":"alice","text":"remember demo day is friday"}'
# Prometheus metrics
curl localhost:3010/metrics
```

See [`examples/curl-recipes.md`](examples/curl-recipes.md) for the full set.

## 📐 Architecture

```
                     ┌────────────────┐
   HTTP / WS / CLI ──▶│    Gateway     │──▶ AgentRuntime ──▶ Brain (deterministic / OpenAI)
                     └───────┬────────┘                    │
        Channels             │                             ▼
        ─────────            ▼                       ToolRegistry
        http, console,  Sessions · Memory                  │
        broadcast,      Conversation · Audit               ▼
        webhook         RateLimit · Quotas         95 built-in tools
                        Pairing · CircuitBreaker          + plugins
                        Scheduler · Cache                 + skills
```

Every subsystem is independently tested and replaceable. The **Gateway** is the single channel-agnostic facade.

## 📊 Project Stats

| Metric | Value |
|---|---|
| Source files | 39 |
| Test files | 36 |
| Lines of TypeScript | 11,200+ |
| Built-in tools | 95 |
| HTTP endpoints | 20+ |
| Test suites | 36 |
| Tests | 392 (all passing) |
| Test runtime | ~13 s |
| Runtime dependencies | 0 |

## 🛠️ Built-in Tools (95)

**Memory:** `memory.save`, `memory.search`, `memory.list`, `memory.forget`, `memory.pin`, `memory.unpin`, `memory.searchAll`
**System:** `status`, `time.now`, `echo`, `session.info`
**Math:** `math.eval`, `math.stats`, `math.round`, `math.clamp`, `math.percentile`, `math.gcd`, `math.lcm`, `math.factorial`, `math.fibonacci`, `math.isPrime`
**Text:** `text.length`, `text.upper`, `text.lower`, `text.reverse`, `text.diff`, `text.normalize`, `text.slugify`, `text.template`, `text.wordcount`, `text.truncate`, `text.repeat`, `text.padLeft`, `text.padRight`, `text.indent`, `text.split`, `text.join`, `text.between`, `text.replaceAll`, `text.escapeHtml`, `text.unescapeHtml`, `text.title`, `text.camel`, `text.snake`, `text.kebab`
**Array:** `array.unique`, `array.flatten`, `array.sort`, `array.chunk`, `array.zip`, `array.range`, `array.intersect`, `array.diff`, `array.shuffle`, `array.head`, `array.tail`, `array.groupBy`
**JSON:** `json.parse`, `json.path`, `json.merge`, `json.diff`
**Crypto:** `hash.sha256`, `hash.md5`, `password.hash`, `password.verify`, `crypto.encrypt`, `crypto.decrypt`, `crypto.randomString`
**Time:** `date.parse`, `date.add`, `time.diff`, `time.format`
**URL/HTTP:** `http.fetch`, `url.parse`, `url.encode`, `url.decode`
**Random:** `random.uuid`, `random.number`, `random.bytes`, `random.pick`
**Validate:** `validate.email`, `validate.url`, `validate.ipv4`, `uuid.validate`
**Encoding:** `base64.encode`, `base64.decode`, `csv.parse`
**Other:** `regex.match`, `regex.replace`, `string.distance`, `geo.distance`, `color.parse`

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

## 📜 License

MIT — see [LICENSE](LICENSE).

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for full version history.
