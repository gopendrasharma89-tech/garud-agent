# Contributing to Garud Agent

Thanks for your interest in improving Garud!

## Development setup

```bash
git clone https://github.com/gopendrasharma89-tech/garud-agent.git
cd garud-agent
npm install
npm run build
npm test
```

## Project layout

```
src/
  agent/          # AgentRuntime — core message loop
  brain/          # Pluggable LLM providers (deterministic, OpenAI)
  cache/          # Tool result cache
  channels/       # HTTP / console / broadcast adapters
  cli/            # CLI entrypoint
  conversation/   # Conversation history store
  core/           # event-bus, memory, sessions, policy, registry, audit, rate-limit, pairing, circuit-breaker
  metrics/        # Prometheus registry
  middleware/     # Dashboard renderer
  plugins/        # Plugin loader
  quotas/         # Per-trust quotas
  scheduler/      # Cron-like scheduler
  skills/         # Skills (markdown) hot-loader
  storage/        # JSON file store with atomic writes
  tools/          # builtin-tools.ts + math-eval.ts
  utils/          # logger, text, timeout, request-id
  webhook/        # HMAC signature verification
  ws/             # WebSocket server (raw upgrade)
  bootstrap.ts    # Composes all subsystems
  config.ts       # Schema + defaults + validation
  gateway.ts      # Channel-agnostic Gateway facade
  server.ts       # HTTP/SSE endpoints
  types.ts        # Shared types
  version.ts      # Centralized version
tests/            # 36 test suites (vitest)
```

## Coding rules

1. **Strict TypeScript** — no `any`, no `@ts-ignore`. Run `npm run lint` before committing.
2. **Zero runtime dependencies** — anything beyond Node stdlib must be discussed first.
3. **Every new tool needs a test** — add to `tests/v{X}-tools.test.ts` or a topical file.
4. **Every new endpoint needs an integration test** in `tests/server.test.ts` or `tests/v{X}-server.test.ts`.
5. **Bug fixes need a regression test** that fails before the fix and passes after.

## Pull request checklist

- [ ] `npm run build` succeeds
- [ ] `npm test` is green (all suites)
- [ ] `npm run lint` passes (CI runs this on Node 20 and 22)
- [ ] Updated `CHANGELOG.md` under an "Unreleased" or new version heading
- [ ] If the public surface changed, updated the README

## Release process

1. Bump `src/version.ts` and `package.json` to the new version.
2. Move `Unreleased` notes in `CHANGELOG.md` to a dated heading.
3. Run `npm test` — must be green.
4. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --tags`
5. Create a GitHub release pointing at the tag.
