---
tags: feature, decision
---

# Add host-side \usage command

## What changed

Added `\usage` as a host-side command that shows rate limit status and reset times. No container is spawned — the
response comes directly from the host process.

## Why

The SDK's built-in `/usage` command only works in the CLI — `query()` returns "Unknown skill: usage" when called via
the Agent SDK. Users need visibility into rate limit status to know when limits reset.

## How it works

1. **Rate limit capture**: The SDK emits `rate_limit_event` messages during every query with `status`, `resetsAt`
   (epoch seconds), and `rateLimitType`. The agent-runner captures these and includes them in
   `ContainerOutput.rateLimits`.

2. **Storage**: Host upserts each rate limit snapshot into a `rate_limits` table (keyed by `rate_limit_type`). Only
   the latest value per type is kept — no historical accumulation needed.

3. **Host command system**: New command category alongside SDK session commands. `extractHostCommand()` mirrors the
   existing `extractSessionCommand()` pattern.

4. **Inline execution**: Host commands execute inline in the message loop — NOT deferred to `processGroupMessages`
   via the queue. This is critical: if deferred, the next poll cycle fetches `allPending` from the DB (which includes
   the unprocessed command) and pipes everything to the active container.

5. **Formatting**: Shows status label (OK / Approaching limit / Rate limited) with reset time. If the SDK ever sends
   `utilization` (0–1), progress bars render automatically.

## SDK limitations discovered

The Agent SDK's `rate_limit_event` only sends:
- `five_hour` session type (no `seven_day`, `seven_day_sonnet`, `seven_day_opus`)
- `utilization: undefined` (percentage not exposed)
- `resetsAt` in seconds (not milliseconds)

Claude Code's `/usage` display with progress bars and weekly breakdowns comes from an internal Anthropic billing API,
not from SDK events. Our implementation is forward-compatible — if the SDK starts exposing more data, it renders
automatically.

## Design decisions

- **Inline execution in message loop**: Host commands MUST execute inline, not via the deferred queue. When a container
  is running, `enqueueMessageCheck` sets `pendingMessages = true` and returns. On the next poll cycle, a non-command
  message falls through to the pipe path, which calls `getMessagesSince` and includes the unprocessed command in
  `allPending`. The fix: execute the command and advance the cursor immediately in the message loop.

- **Host commands as a category**: General `HOST_COMMANDS` set for future expansion (e.g., `/status`, `/groups`).

- **Same auth model as session commands**: Main group or `is_from_me`.

- **`executeHostCommand` as optional dep on SessionCommandDeps**: Backwards-compatible with existing tests. Also wired
  directly in the message loop for the inline execution path.

- **Epoch seconds detection**: `resetsAt < 1e12` → multiply by 1000. Prevents the "Jan 21 1970" bug.

## Files

- `container/agent-runner/src/utils.ts` — `RateLimitSnapshot` interface
- `container/agent-runner/src/index.ts` — Captures `rate_limit_event` messages, includes in output
- `src/container-runner.ts` — Mirrored `RateLimitSnapshot` type on host side
- `src/db.ts` — `rate_limits` table, `upsertRateLimit()`, `getRateLimits()`
- `src/session-commands.ts` — `HOST_COMMANDS`, `extractHostCommand()`, host command handling
- `src/host-commands.ts` — New file: `executeHostCommand()`, `executeUsageCommand()`, progress bar rendering
- `src/index.ts` — Inline host command execution in message loop, rate limit persistence in `wrappedOnOutput`
