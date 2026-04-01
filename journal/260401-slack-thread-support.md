# Slack Thread Support

**Date:** 2026-04-01

## What Changed

Added full Slack thread support: when a user replies in a Slack thread and mentions the agent,
the agent sees the complete thread history as context and replies within the same thread.
Non-threaded messages continue to work exactly as before.

## Layers Modified

The change threads an optional `thread_ts` parameter through 6 layers:

1. **Types** (`src/types.ts`) — Added `thread_ts?: string` to `NewMessage` interface and
   optional `threadTs` parameter to `Channel.sendMessage()`.

2. **Database** (`src/db.ts`) — Migration v6 adds `thread_ts` column and index to the
   `messages` table. New `getThreadMessages()` function fetches all messages in a thread.
   `storeMessage()`, `storeMessageDirect()`, `getNewMessages()`, and `getMessagesSince()`
   updated to handle thread_ts.

3. **Slack channel** (`src/channels/slack.ts`) — Captures `thread_ts` from incoming Slack
   messages (previously discarded with an explicit "flattened" comment). `sendMessage()` and
   `sendBlocks()` forward `thread_ts` to Slack's `chat.postMessage()`. Outgoing queue preserves
   thread context.

4. **MCP tools** (`container/agent-runner/src/ipc-mcp-stdio.ts`) — `send_message` and
   `send_blocks` tools accept optional `thread_id` parameter so agents can explicitly target
   threads.

5. **IPC layer** (`src/ipc.ts`) — Forwards `threadTs` from IPC messages to `sendMessage()`
   and `sendBlocks()`.

6. **Orchestrator** (`src/index.ts`) — Thread-aware context in both `processGroupMessages()`
   and the message loop pipe path. When threaded messages are detected, fetches full thread
   history from DB and includes it in the prompt. Routes streaming output to the thread.

7. **Formatter** (`src/router.ts`) — Includes `thread_ts` attribute in `<message>` XML so
   the agent knows which thread context it's operating in.

## Design Decisions

- **Thread parents are non-threaded:** When `thread_ts === ts` (the message IS the parent),
  we treat it as a regular channel message. Only actual replies (where `thread_ts !== ts`)
  get thread_ts set. This prevents unnecessary thread context creation for the first message.

- **Full thread history:** The agent sees the entire thread, not just the triggering message.
  This was a deliberate choice for context richness — the agent can understand the full
  conversation before responding.

- **Backward compatible:** Every change is optional. The `thread_ts` field, the `threadTs`
  parameter in `sendMessage()`, and the `thread_id` MCP tool parameter are all optional.
  If omitted, behavior is identical to before this change.

- **Safe fallback:** If thread_ts is lost or corrupted, messages fall back to posting in the
  channel root. The worst case is "replies in channel" not "message lost."

## Test Coverage

Added 20+ new tests across 3 test files:
- `db.test.ts`: thread_ts storage/retrieval, `getThreadMessages()`, bot message filtering,
  schema version assertions updated to v6
- `formatting.test.ts`: thread_ts attribute in XML output, mixed threaded/non-threaded messages
- `slack.test.ts`: thread_ts capture for replies vs parents vs non-threaded, sendMessage with
  thread_ts (including splits and queuing), sendBlocks with thread_ts

All 770 tests pass.
