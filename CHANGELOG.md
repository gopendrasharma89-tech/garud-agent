# Changelog

All notable changes to **Garud Agent** are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-05-06 — "Garuda"

First stable release. Production-ready, polished, fully documented.

### Added
- **11 new tools** → 95 built-in tools total
  - `array.groupBy` — group items by JSON path key
  - `text.title`, `text.camel`, `text.snake`, `text.kebab` — case conversions
  - `math.factorial` (0–1000), `math.fibonacci` (0–1476), `math.isPrime`
- **GitHub Actions CI** — build + test + type-check on Node 20.x and 22.x
- **CHANGELOG.md**, **CONTRIBUTING.md**, **examples/** directory
- **Issue templates** for bugs and feature requests
- Comprehensive README with badges, architecture, usage, examples

### Fixed
- `array.shuffle` now safely handles empty and single-element arrays
- Outdated package.json description (mentioned "320+ tests")
- Repository metadata enriched (keywords, repo, bugs, homepage)

### Stats
- **392 tests pass** across 36 suites in ~13 s
- **39 source files**, **36 test files**, **11,200+ lines** of TypeScript
- Strict TypeScript, zero runtime dependencies

## [0.9.0] — 2026-05-04 — "Shakti"
- 13 new tools (`array.shuffle`, `array.head/tail`, `text.split/join/between/replaceAll/escapeHtml/unescapeHtml`, `math.percentile/gcd/lcm`, `uuid.validate`)
- Type-aware `array.intersect` / `array.diff` (no `1` vs `"1"` collision)
- Stricter `validate.email` regex
- Multi-char pad in `text.padLeft` / `text.padRight`
- 84 tools, 381 tests

## [0.8.0] — 2026-05-03 — "Tej"
- 13 new tools (`array.range/intersect/diff`, `text.padLeft/padRight/indent`, `math.round/clamp`, `geo.distance`, `crypto.randomString`, `validate.email/url/ipv4`)
- Fixed `text.truncate`/`text.repeat` parsing for inputs containing `::`
- 71 tools, 361 tests

## [0.7.0] — 2026-05-02 — "Vajra"
- 10 new tools (`array.sort/chunk/zip`, `text.wordcount/truncate/repeat`, `math.stats`, `json.merge/diff`, `color.parse`)
- Word-boundary aware SSE chunking
- `array.flatten` depth parameter
- `time.format` `rfc2822` / `long` formats
- `/api/version` endpoint with build metadata
- 58 tools, 341 tests

## [0.6.0]
- 9 new tools (`text.slugify/template`, `string.distance`, `json.path`, `array.unique/flatten`, `random.pick`, `time.diff/format`)
- New endpoints: `/live`, `/slo`, `/audit/export`, `/sessions/:id/forget`
- Centralized version constant
- 48 tools, 320 tests

## [0.5.0]
- 12 new tools (`csv.parse`, `yaml.parse`, `url.encode/decode`, `text.diff`, `password.hash/verify`, `crypto.encrypt/decrypt`, `unicode.normalize`, `date.parse/add`)
- Tool quotas, webhook HMAC, conversation store, memory pinning/TTL, audit replay
- 39 tools, 298 tests

## [0.4.0]
- WebSocket server, tool result cache, circuit breaker, Prometheus metrics
- Built-in dashboard, signed webhooks, request-ID tracing
- 27 tools, 245 tests

## [0.3.0]
- Pairing flow, cron scheduler, plugin/skills loaders
- 17 tools, 199 tests

## [0.2.0]
- Pluggable brain providers, audit log, rate limiter
- 10 tools, 90 tests
