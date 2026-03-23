# Slack Typing Indicator Fix and Documentation MCP Server

Date: 2026-03-23

## Slack Typing Indicator Bug

### Problem

Users experienced the agent as "unresponsive" in multi-turn Slack conversations. After sending a follow-up message
to a running container, there was no visible feedback for up to 60 seconds while the agent processed MCP tool calls.

### Root Cause

The `:eyes:` reaction (Slack's typing indicator) was eagerly removed inside `sendMessage()` and `sendBlocks()` in
`src/channels/slack.ts`. The lifecycle was:

1. User sends message → `:eyes:` added via `setTyping(true)`
2. Agent responds → `sendMessage()` calls `removeWorkingReaction()` → `:eyes:` gone
3. User sends follow-up → message sits in DB until next poll (2s+)
4. Poll detects message → pipes to container → `setTyping(true)` re-adds `:eyes:`

Between steps 2 and 4, there was a gap with **no indicator**. If the MCP call took 30-60 seconds, the user saw
nothing and assumed the agent was broken.

### Fix

- Removed `removeWorkingReaction()` from `sendMessage()` and `sendBlocks()` — these methods no longer touch the
  typing reaction
- Added `channel.setTyping(false)` in the output callback in `src/index.ts` after a successful result, so the
  reaction is removed cleanly after the response is posted (not before)
- The reaction lifecycle is now managed exclusively by `setTyping()`:
  - `setTyping(true, msgTs)` — called when a message is piped or a container spawns
  - `setTyping(false)` — called after each successful output AND when the container exits

### Result

The `:eyes:` reaction now persists for the entire agent processing duration. In multi-turn conversations, it's
re-added immediately when the next message is piped. No more "unresponsive" gaps.

### Tests

- Updated 2 existing tests (previously asserted sendMessage removes reaction → now assert it doesn't)
- Added 3 new regression tests: multi-response persistence, sendBlocks preservation, full lifecycle

## Read-Only SDK Commands Blocked in Non-Main Groups

### Problem

`/model` and `/skills` commands were unresponsive in non-main Slack channels. The commands were detected but
the container never exited to process them.

### Root Cause

The message loop's SDK command path (line ~684 in `src/index.ts`) guarded `closeStdin` behind
`isSessionCommandAllowed(isMainGroup, isFromMe)`. For non-main groups with non-admin senders (Slack users have
`is_from_me: false`), this returned false. `closeStdin` was never called, so the active container kept running.

The command was enqueued via `queue.enqueueMessageCheck()`, but since the container was still active,
`enqueueMessageCheck` just set `pendingMessages = true` and returned — the pending check only runs when the
container exits. The container would only exit on idle timeout (30 minutes).

Meanwhile, `handleSessionCommand` (called from `processGroupMessages`) correctly allows read-only commands
without auth. The mismatch was between the message loop gate and the processing gate.

### Fix

Added `isReadOnlyCommand(cmd)` to the `closeStdin` gate in the message loop:
```
if (isReadOnlyCommand(cmd) || isSessionCommandAllowed(...)) {
  queue.closeStdin(chatJid);
}
```

### Test

Added regression test in `session-commands.test.ts` verifying the combined gate invariant:
`isReadOnlyCommand(cmd) || isSessionCommandAllowed(false, false)` must be true for all non-intercepted
read-only commands (`/model`, `/skills`, `/status`).

Total: 677 tests passing.

## Documentation MCP Server Integration

Added support for an HTTP MCP documentation server (`DOCS_MCP_URL` env var) that agents can use to search
indexed documentation.

### Changes

- `container/agent-runner/src/index.ts` — Added `docs` MCP server (HTTP type, conditional on `DOCS_MCP_URL`),
  added `mcp__docs__*` to allowed tools
- `src/container-runner.ts` — Added `DOCS_MCP_URL` to container env passthrough
- `.env` — Added `DOCS_MCP_URL=http://192.168.2.106:8085/mcp`
- Created `groups/slack_docs/` group folder with `CLAUDE.md` instructing the agent to use MCP docs tools
- Registered `slack:C0ANCLZDSQL` (#docs channel) in the DB

### MCP Server Tools

The documentation server (running on the infra VM) exposes:
- `search_docs` — semantic search across indexed documentation
- `query_docs` — structured metadata filtering
- `get_document` — retrieve specific documents by ID
- `list_sources` — list indexed sources
- `reindex` — trigger re-indexing

## Default Model Set to Opus

### Problem

New channels defaulted to Sonnet (the SDK default) unless a `config.json` with `"model": "opus"` was manually
created in the group folder. Easy to forget.

### Fix

Added `DEFAULT_MODEL = 'claude-opus-4-6'` in `src/group-config.ts`. All fallback paths in `readGroupConfig()`
now return opus: missing config file, invalid JSON, missing model field, non-string model field. Per-group
overrides still work — if a group has `{ "model": "sonnet" }`, it uses sonnet. But any new channel automatically
gets opus without manual setup.
