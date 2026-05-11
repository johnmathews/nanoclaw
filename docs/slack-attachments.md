# Slack — Attachments, Threads, Reactions

Slack is a first-class channel. This doc covers the three Slack-specific behaviors that aren't shared with other
channels: file attachments, thread context, and reactions.

## File Attachments

When a Slack message includes file attachments, `src/channels/slack.ts` downloads them, embeds text references in the
message body, and queues image bytes for the host-side multimodal pipeline.

### Per-type handling

| File type        | Download path                                          | Reference embedded in message               | How the agent uses it |
| ---------------- | ------------------------------------------------------ | ------------------------------------------- | --------------------- |
| `audio/*`        | (not persisted — sent directly to Whisper)             | `[Voice note: <transcript>]`                | Reads transcript      |
| `image/*`        | `groups/{folder}/attachments/img-{ts}-{fileId}.{ext}`  | `[Image attached: attachments/<file>]`      | Multimodal vision     |
| `application/pdf`| `groups/{folder}/attachments/{fileId}-{name}.pdf`      | `[PDF: attachments/<file> (<size>)]`<br>`Use: pdf-reader extract attachments/<file>` | PDF reader tool |
| Other            | `groups/{folder}/attachments/{fileId}-{name}`          | `[File attached: attachments/<file>] (type, size)` | Bash tools     |

PDFs get a dedicated reference because they need a CLI tool (`pdf-reader`) rather than the multimodal pipeline — see
`/add-pdf-reader` skill. Audio uses **the original Slack filename and mimetype** (typically `.m4a`/`audio/mp4`) when
calling Whisper for best accuracy.

### Image lifecycle (host-side)

Images are loaded into base64 on the **host** before the container is spawned, not read from files inside the
container:

1. `slack.ts` downloads and processes the image into `attachments/`
2. Before container spawn, `loadImageData()` in `src/image.ts` reads each file into memory and **deletes it
   immediately**
3. Base64 bytes go to the container via `ContainerInput.imageAttachments` (JSON over stdin)
4. The agent-runner sends the bytes directly to Claude as multimodal content blocks

This sequence eliminates the race conditions an in-container read would create. Groups with
`"skipImageMultimodal": true` in their `config.json` get a different path: the file is deleted via
`cleanupImageFiles()` without ever being loaded into memory, and only the text reference makes it to the agent.
Useful when an MCP server is handling vision/OCR for that group and the LLM doesn't need to see the binary.

### Slack message format

References are embedded directly in the `content` string, keeping backward compatibility with all channels:

```
User's text message
[Image attached: attachments/img-1710756000000-F12345.png]
[File attached: attachments/F67890-report.xlsx] (Excel Spreadsheet, 24.5 KB)
[PDF: attachments/F11111-deck.pdf (1.2 MB)]
Use: pdf-reader extract attachments/F11111-deck.pdf
[Voice note: Hey, can you check the latest deployment?]
```

### Reply length

Slack rejects messages over 4000 characters. `sendMessage()` in `slack.ts` splits longer responses on word boundaries
(`MAX_MESSAGE_LENGTH = 4000` in `src/channels/slack.ts:38`). Multi-part replies post sequentially into the same
channel (or thread).

## Thread Support

When a user replies in a thread and mentions the agent, the agent receives the **full thread history** as context
and replies inline. Non-threaded mentions continue to reply to the channel root.

### Mechanics

1. `thread_ts` is captured on incoming messages. Thread replies have `thread_ts` set to the parent's `ts`; thread
   parents (`thread_ts === ts`) and non-threaded messages get `thread_ts = undefined` so they don't create spurious
   thread context for the first message.
2. `thread_ts` is persisted in the `messages` table (DB migration v6) and included in `NewMessage`.
3. The message loop detects threaded inbound messages, calls `getThreadMessages()` to pull the whole thread, and
   includes it in the prompt with a `thread_ts` attribute on the `<message>` XML so the agent knows where it's
   replying.
4. The agent's streaming output is routed via `channel.sendMessage(jid, text, threadTs)`. The `Channel` interface's
   `sendMessage` accepts an optional `threadTs`; non-Slack channels ignore it.
5. The `send_message` and `send_blocks` MCP tools accept an optional `thread_id` for explicit thread targeting.

Thread context is also delivered for the pipe path (messages piped to an already-running container), so multi-turn
thread conversations stay coherent.

## Channel Typing Indicators

> **Canonical cross-channel reference.** CLAUDE.md / SPEC.md / fork-divergence.md point at this section rather than
> re-stating the gating rules.

NanoClaw signals "the agent is working" to the user via two independent mechanisms. Exactly one of them fires per
message, based on the channel's `Channel.hasNativeTyping` flag.

### Native typing indicators (Slack, WhatsApp, Telegram)

Channels that declare `hasNativeTyping = true` use their platform's own indicator API:

- **Slack** — a `:eyes:` reaction is added to the user's message via `setTyping(true, messageTs)` while the agent is
  working, and removed via `setTyping(false)` after each successful output and when the container exits.
  (`WORKING_REACTION = 'eyes'` in `src/channels/slack.ts:73`.)
- **WhatsApp** — `sendPresenceUpdate('composing' | 'paused')` on the chat.
- **Telegram** — `sendChatAction('typing')`.

### StatusTracker progress reactions (other channels)

Channels that declare `hasNativeTyping = false` (or omit it — Gmail) get the
[`StatusTracker`](../src/status-tracker.ts) instead: progressive emoji reactions
(received → thinking → working → done → failed) attached to the originating message, with state persisted to
`data/status-tracker.json` across restarts.

### The gating rules

StatusTracker fires only when **both** conditions hold:

1. The group is the **main group** (StatusTracker is silenced for non-main groups regardless of channel).
2. The channel does **not** declare `hasNativeTyping=true`.

In practice today: Slack/WhatsApp/Telegram use native indicators; Gmail-channel groups don't get any indicator
because Gmail-channel groups are typically not the main group (and Gmail wouldn't have a sensible "typing" surface
even if they were).

### Slack-specific implementation notes

- `sendMessage()` and `sendBlocks()` do **not** touch the `:eyes:` reaction — this prevents indicator gaps in
  multi-turn conversations where the container is still alive processing piped messages.
- When piped messages switch the reaction to a new message, the old reaction is removed first so we don't leave
  orphaned `:eyes:` on prior messages.
- IPC-delivered messages (`send_message` tool) also clear the typing indicator, since they bypass the streaming
  output path.
- Reaction removal failures are logged at `warn` for production visibility (they tend to be the symptom of token
  scope or rate-limit issues).

## Required Slack App Scopes

| Scope             | Why                                          |
| ----------------- | -------------------------------------------- |
| `channels:history`| Receive `message` and `file_share` events    |
| `files:read`      | Download attachment bytes                    |
| `chat:write`      | Send replies                                 |
| `reactions:write` | `:eyes:` working indicator                   |
| `groups:history`  | (Optional) Private channels                  |
| `im:history`      | (Optional) Direct messages                   |

Add at [api.slack.com/apps](https://api.slack.com/apps) → **OAuth & Permissions → Bot Token Scopes**, then reinstall
the app to the workspace.

## Relevant Files

| File                       | Role                                                   |
| -------------------------- | ------------------------------------------------------ |
| `src/channels/slack.ts`    | Event handling, file download, threading, reactions    |
| `src/image.ts`             | Host-side base64 loading + cleanup                     |
| `src/transcription.ts`     | Whisper API client (also used by other audio sources)  |
| `src/container-runner.ts`  | Image payload passthrough to agent-runner              |
| `src/db.ts`                | `thread_ts` migration (v6) and `getThreadMessages()`   |

## Related Journal Entries

- [260318-add-slack-attachments.md](../journal/260318-add-slack-attachments.md)
- [260318-fix-slack-voice-transcription.md](../journal/260318-fix-slack-voice-transcription.md)
- [260319-fix-image-attachment-reliability.md](../journal/260319-fix-image-attachment-reliability.md)
- [260331-fix-slack-reaction-leaks.md](../journal/260331-fix-slack-reaction-leaks.md)
- [260401-slack-thread-support.md](../journal/260401-slack-thread-support.md)
- [260409-skip-image-multimodal-for-mcp-groups.md](../journal/260409-skip-image-multimodal-for-mcp-groups.md)
