# Generic slash command forwarding and live usage API

## What changed

Two related changes in one session:

1. **Generic slash command forwarding** — removed whitelists (`SDK_SESSION_COMMANDS`, `HOST_COMMANDS`) so any
   `\word` from Slack/WhatsApp is recognized as a command. Commands are either intercepted on the host (`/usage`)
   or forwarded generically to the SDK inside a container (`/compact`, `/clear`, `/done`, `/help`, anything else).

2. **Live usage API** — `\usage` now fetches real utilization data from `console.anthropic.com/api/oauth/usage`
   using the OAuth token stored in `~/.claude/.credentials.json`. Returns 5-hour session, 7-day weekly, and
   per-model utilization percentages with progress bars — the same data Claude Code's interactive `/usage` shows.
   Falls back to DB-stored rate limit snapshots if the API call fails.

## Why

The previous implementation had two problems:
- Whitelists meant only `/compact`, `/clear`, and `/usage` worked. Any other SDK command (e.g., `/done`, `/help`)
  was silently ignored.
- The `/usage` output only showed status labels (OK/Approaching limit/Rate limited) from SDK `rate_limit_event`
  messages, which lack utilization percentages. Users wanted the same progress bars they see in Claude Code.

## Design decisions

- **Single `extractCommand()` function** replaces `extractSessionCommand()` + `extractHostCommand()`. Any
  `\word` or `/word` is extracted; `isInterceptedCommand()` determines routing.

- **`INTERCEPTED_COMMANDS` set** (currently just `/usage`) — commands handled on the host without spawning a
  container. Everything else is forwarded to the SDK. If the SDK doesn't recognize it, the error is relayed
  as-is to the user.

- **API-first with DB fallback** for `/usage` — the OAuth endpoint gives rich data (utilization percentages,
  per-model breakdowns). The DB fallback using `rate_limit_event` snapshots handles cases where the API is
  unreachable or the token is missing.

- **OAuth token from `~/.claude/.credentials.json`** — read on every invocation (no caching), so token
  refreshes are picked up automatically. The endpoint is `console.anthropic.com/api/oauth/usage` with the
  token in an `x-api-key` header (not Authorization Bearer — discovered via testing).

- **Utilization values are percentages (0–100)** from the API, divided by 100 for the progress bar renderer
  which expects 0–1. The DB fallback path already handled 0–1 values from SDK events.

## Files

- `src/session-commands.ts` — `extractCommand()`, `isInterceptedCommand()`, unified `handleSessionCommand()`
- `src/host-commands.ts` — `fetchUsageFromApi()`, `formatApiUsage()`, API-first `/usage` with DB fallback
- `src/index.ts` — unified inline command interception block
- `src/session-commands.test.ts` — rewritten for generic commands
- `src/host-commands.test.ts` — added API fetch tests with mocked `fetch()`
- `CLAUDE.md` — updated Slash Commands and Usage Tracking sections
