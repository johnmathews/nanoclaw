---
date: 2026-03-17
tags: [feature, decision]
---

# Slack Working Indicator with Live Progress

## What

Added a visible "working..." indicator in Slack that shows what the agent is doing in real-time, then gets replaced by
the actual response. When you message the agent, you now see status updates like _"Reading files..."_,
_"Running command..."_, _"Searching codebase..."_ cycling in-place until the response arrives.

## Why

Slack's Bot API has no typing indicator endpoint for bots (`setTyping` was a no-op). Users had zero feedback that
anything was happening after sending a message — sometimes for 10-30+ seconds. This was especially jarring for tasks
that involve multiple tool calls.

## How it works

Two-layer system:

### Layer 1: Working indicator (post-then-update)

When the orchestrator calls `setTyping(jid, true)`, the Slack channel posts a _"Working on it..."_ message via
`chat.postMessage()` and stores the message `ts`. When the first real response arrives via `sendMessage()`, it uses
`chat.update()` to replace the placeholder in-place. If the agent finishes without output, `setTyping(false)` deletes
the placeholder via `chat.delete()`.

### Layer 2: Live progress from agent tool use

The agent-runner inside the container intercepts `assistant` messages from the Claude Agent SDK. When a message contains
`tool_use` content blocks, it emits a progress marker to stdout:

```
---NANOCLAW_PROGRESS_START---
{"text":"Reading files"}
---NANOCLAW_PROGRESS_END---
```

The container-runner on the host parses these markers (alongside the existing output markers) and calls an `onProgress`
callback. The orchestrator passes this through to `channel.updateWorkingIndicator()`, which uses `chat.update()` to
change the placeholder text. Rate-limited to one update per 3 seconds to avoid Slack API throttling.

Tool name mapping (in agent-runner):

- `Read` -> "Reading files"
- `Edit`/`Write` -> "Editing code" / "Writing code"
- `Bash` -> "Running command"
- `Grep`/`Glob` -> "Searching codebase" / "Searching for files"
- `WebSearch`/`WebFetch` -> "Searching the web" / "Fetching web content"
- MCP tools -> "Using {server}: {tool_name}"

## Files changed

| File                                  | Change                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/channels/slack.ts`               | `setTyping()` posts/deletes placeholder; `sendMessage()`/`sendBlocks()` update placeholder with response; `updateWorkingIndicator()` for progress text with rate limiting |
| `src/types.ts`                        | Added optional `updateWorkingIndicator?(jid, text)` to Channel interface                                                                                                  |
| `container/agent-runner/src/index.ts` | Progress markers emitted on tool_use blocks; tool name -> friendly label mapping                                                                                          |
| `src/container-runner.ts`             | Parses `PROGRESS_START/END` markers; `onProgress` callback parameter; always syncs agent-runner source to session mounts                                                  |
| `src/index.ts`                        | Wires `onProgress` callback from container-runner to `channel.updateWorkingIndicator()`                                                                                   |

## Design decisions

### Why not ephemeral messages?

Slack ephemeral messages (`chat.postEphemeral`) cannot be updated or deleted by the bot. They only disappear on
refresh/navigate, so they can't be "replaced" by the real response.

### Why post-then-update instead of post-then-delete?

Updating in-place is smoother — no flicker between deleting the old message and posting a new one. The message
transforms from placeholder to response seamlessly.

### Why rate-limit progress updates?

Slack's API has rate limits. An agent might call 10+ tools in rapid succession. Capping updates at one per 3 seconds
prevents throttling while still giving meaningful feedback.

### Why fire-and-forget for progress updates?

`updateWorkingIndicator()` is synchronous (returns void) and doesn't await the API call. Progress updates are
best-effort — if one fails, the next one or the final response will still work. This avoids blocking the agent's
execution pipeline.

## Gotcha: agent-runner-src session mount

The container mounts `/app/src` from a host directory (`data/sessions/{group}/agent-runner-src`). Previously this was
only populated on first run (`!fs.existsSync` check), meaning container image rebuilds had no effect on existing groups.
Fixed by always copying the source on container spawn. This was the main debugging pain point during implementation.

## Architecture note

The progress system follows the same stdout marker protocol as the existing output system. Progress markers
(`PROGRESS_START/END`) are parsed by the same buffer scanner in `container-runner.ts`, just with a separate marker pair.
This keeps the communication channel simple — no new IPC paths, no new polling, just additional marker types on stdout.

The Channel interface makes this opt-in: `updateWorkingIndicator?()` is optional, so channels that don't support it
(WhatsApp, Telegram, etc.) simply don't implement it. The orchestrator uses optional chaining
(`channel.updateWorkingIndicator?.()`).
