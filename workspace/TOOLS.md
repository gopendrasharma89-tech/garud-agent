# Tool conventions

All tools accept a single string input and return `{ content, metadata?, error? }`.

## Built-in tools
- `memory.save` — persistent note for the current session.
- `memory.search` — token-overlap retrieval; returns top 5 by default.
- `memory.list` — recent memories, default 5.
- `memory.forget` — delete by id (destructive, owner only).
- `status` — health summary.
- `time.now` — UTC ISO timestamp.
- `echo` — returns input unchanged.
- `math.eval` — safe arithmetic only (+ - * / % **).
- `http.fetch` — GET URL, capped at 4KB body.
- `session.info` — current session metadata.

## Authoring guidance
- Keep results small (under 4KB) unless metadata flags otherwise.
- Always set `error: true` on failures and put a short reason in `content`.
- Tag tools with: `read | write | safe | destructive | shell | network | memory`.
