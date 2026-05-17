# The Garud Mascot — "Skyforge"

Garud's mascot is a stylized falcon — sharp, focused, and silent in flight. It
represents the project's identity:

- **Sharp** — strict TypeScript, zero runtime dependencies
- **Focused** — single Gateway daemon, single-writer state
- **Silent** — local-first; no network calls unless you opt in

Rendered ASCII art (default in the terminal):

```
        ___                          ___
       /   \    ___    ___    /   \
      |     \__/   \__/   \__/     |
       \__   //O  <  O\\   __/
          \__\____/__/
              |||
             /   \
            GARUD
```

The mascot is shown by:

- `garud --help`
- `garud mascot`
- The CLI welcome banner

It auto-detects whether stdout is a TTY and only emits ANSI color escapes when
appropriate, so it stays readable in CI logs and piped output.

## Why a falcon?

The project name **Garud** comes from a mythological winged figure known across
several Asian cultures (Indian, Indonesian, Thai, Nepali). The mascot's
stylized "Skyforge" falcon is intentionally neutral — easy to recognize as a
bird of prey without being tied to any one regional style. This makes Garud
welcoming to a global audience while keeping a soaring, decisive identity.

## Building the mascot

The mascot is a single TypeScript module — `src/mascot.ts` — with two exports:

- `mascot(opts)` — multi-line art with tagline (optional ANSI color)
- `mascotInline(opts)` — single-line `~< GARUD >~` for log prefixes

Both functions are pure and side-effect-free. Add new ASCII art by editing
that file and adding a corresponding test in `tests/v30-workspace.test.ts`.
