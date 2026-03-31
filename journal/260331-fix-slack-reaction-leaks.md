# Fix Slack :eyes: reaction leaks

Two bugs were causing the `:eyes:` typing indicator reaction to persist on Slack messages
after the agent finished responding.

## Bug 1: Orphaned reactions on piped messages

The `workingReactions` map stores one message timestamp per channel. When a new message is
piped to a running container, `setTyping(true, newMsgTs)` added a reaction to the new message
but silently overwrote the map entry — the old message's reaction was never removed.

**Fix:** Before adding a reaction to a new message, check if there's an existing reaction on
a different message and remove it first (`slack.ts:415-420`).

**Observed in:** main-group at 09:02 — message B got a reaction when message C was piped,
but B's reaction was never cleaned up because the map was overwritten to point at C.

## Bug 2: IPC `send_message` bypasses typing indicator cleanup

When agents send all their output via the IPC `send_message` tool (instead of streaming
output markers), the `onOutput` callback in `index.ts` is never called, so `setTyping(false)`
never fires. The reaction persists until the container exits — which can be much later.

**Fix:** Added `setTyping` to `IpcDeps` interface and call `setTyping(false)` after forwarding
IPC messages and blocks (`ipc.ts:99-101, 127`). Wired up in `index.ts:1170-1174`.

**Observed in:** nanoclaw-git-maintenance at 10:06 — container sent all output via IPC, so
the reaction was never removed while the container was still running.

## Logging improvement

Reaction removal failures were logged at `debug` level, making them invisible in production.
Promoted to `warn` level so failures are visible in `journalctl` output.

## Tests added

8 new tests covering orphan prevention (4 tests) and edge cases (4 tests): same-ts no-op,
add failure after old removal, idempotent setTyping(false), double-stop from streaming +
container exit.
