# Generic slash command forwarding from Slack

Slack intercepts messages starting with `/` as native slash commands, so users can't type
`/done`, `/compact`, `/usage` etc. directly. The fix: recognize `\command` (backslash) in
messages and normalize to `/command` before forwarding to the SDK.

## What changed

- **`src/session-commands.ts`** — `extractSessionCommand()` now matches any `\word` or `/word`
  via regex instead of hardcoding `/compact`. Backslash is normalized to forward slash.

- **`container/agent-runner/src/index.ts`** — Removed the `KNOWN_SESSION_COMMANDS` whitelist.
  Any single-word `/command` prompt is now treated as a session slash command and forwarded
  directly to the SDK. Removed compact-specific `compactBoundarySeen` tracking and fallback
  messages in favor of generic `'Command completed.'`.

- **Tests** — Added coverage for backslash normalization, generic commands (`/done`, `/usage`,
  `/help`), bare slash/backslash rejection, and end-to-end `handleSessionCommand` with
  backslash input.

## Design decisions

- The regex `^[/\\](\w+)$` ensures only single-word commands are intercepted. Multi-word
  messages starting with `/` pass through as normal prompts — this prevents false positives.

- Removed compact_boundary observation logging. It was compact-specific diagnostic code that
  doesn't generalize. The SDK's own result/error reporting is sufficient for all commands.

- Agent-runner changes take effect on next container spawn (source mount auto-sync), so no
  container rebuild needed.
