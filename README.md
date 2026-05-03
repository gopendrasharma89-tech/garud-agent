# 🦅 Garud Agent

Local-first, policy-aware multi-channel agent gateway with pluggable LLM brains, persistent memory, tools, scheduler, pairing, plugins, skills, WebSocket, signed webhooks, dashboard, Prometheus metrics, and more.

**Version:** 0.8.0 "Tej" · Released 2026-05-03 · Zero runtime dependencies · Strict TypeScript

## Highlights
- **71 built-in tools** (memory, math, text, json, crypto, time, geo, validate, color, ...)
- **361 tests pass** across 34 suites in ~12s
- **20+ HTTP endpoints**: `/health`, `/live`, `/ready`, `/slo`, `/metrics`, `/api/version`, `/audit/export`, `/sessions/:id/forget`, ...
- **WebSocket server** with auth, ping/pong, broadcast
- **Signed webhooks** (HMAC-SHA256)
- **Built-in dashboard** at `/`
- **Prometheus metrics** at `/metrics`
- **Pluggable brain providers**: deterministic (built-in) or OpenAI-compatible

## Quick Start
```bash
npm install
npm run build
npm test
npm start             # boot HTTP server (default :3010)
npm run cli help      # CLI: chat, send, repl, sessions, memories, tools, audit, ...
```

## License
MIT
