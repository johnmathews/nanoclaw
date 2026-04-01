# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills
that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has
isolated filesystem and memory.

## Key Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                      | Orchestrator: state, message loop, agent invocation        |
| `src/channels/registry.ts`          | Channel registry (self-registration at startup)            |
| `src/ipc.ts`                        | IPC watcher and task processing                            |
| `src/router.ts`                     | Message formatting and outbound routing                    |
| `src/config.ts`                     | Trigger pattern, paths, intervals                          |
| `src/container-runner.ts`           | Spawns agent containers with mounts, parses progress       |
| `src/task-scheduler.ts`             | Runs scheduled tasks                                       |
| `src/image.ts`                      | Image processing, base64 loading, reference parsing        |
| `src/transcription.ts`              | Voice message transcription via OpenAI Whisper             |
| `src/db.ts`                         | SQLite operations                                          |
| `src/host-commands.ts`              | Host-side commands (/usage, /status) — no container spawn  |
| `src/health.ts`                     | Health data collection (pure function, used by all levels) |
| `src/health-server.ts`              | HTTP health endpoint (GET /health on port 3002)            |
| `src/watchdog.ts`                   | Systemd watchdog integration (sd_notify)                   |
| `src/session-commands.ts`           | Session + host command extraction and handling             |
| `store/messages.db`                 | SQLite database (messages, chats, tasks, sessions, state)  |
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |
| `groups/{name}/config.json`         | Per-group config (model override, etc.)                    |
| `src/group-config.ts`               | Reads and resolves per-group config                        |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration    |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install         |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## WhatsApp Dedicated Number

The agent runs on its own WhatsApp Business account (`ASSISTANT_HAS_OWN_NUMBER=true`). This means:

- The agent has a separate phone number (eSIM) linked via WhatsApp Business
- No message prefix needed — `fromMe` flag distinguishes bot messages from user messages
- Chat looks like a normal 1-on-1 conversation
- Auth uses pairing code (`npm run auth --pairing-code --phone <number>`) — more reliable than QR in terminals

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run
`/add-whatsapp` (or
`git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`)
to install it. Existing auth credentials and groups are preserved.

## Slack Thread Support

When a user replies in a Slack thread and mentions the agent, the agent sees the **full thread history** as context
and replies within the same thread. Non-threaded messages continue to work as before (replies go to the channel root).

**How it works:**

1. Slack's `thread_ts` is captured on incoming messages. Thread replies have `thread_ts` set to the parent message's ts;
   non-threaded messages and thread parents have `thread_ts = undefined`.
2. The `thread_ts` is stored in the `messages` DB table (migration v6) and included in `NewMessage`.
3. When `processGroupMessages` detects threaded messages, it fetches the full thread from DB via `getThreadMessages()`
   and includes it as context in the prompt. The `<message>` XML includes a `thread_ts` attribute so the agent knows
   which thread it's replying to.
4. The agent's streaming output is routed to the thread via `channel.sendMessage(jid, text, threadTs)`.
5. The `send_message` and `send_blocks` MCP tools accept an optional `thread_id` parameter for explicit thread targeting.
6. The IPC layer passes `threadTs` through from container to host to channel.

**Design decisions:**
- Thread parents (where `thread_ts === ts`) are treated as non-threaded to avoid creating unnecessary thread context
  for the first message in a thread.
- The `Channel` interface's `sendMessage` accepts an optional `threadTs` parameter. Non-Slack channels ignore it.
- Thread context is also provided for the pipe path (messages piped to an already-running container).

## Channel Typing Indicators

Channels declare `hasNativeTyping = true` if they have built-in typing/working indicators. This prevents the
StatusTracker from sending redundant emoji reactions (which can also cause feedback loops).

- **WhatsApp**: Native `sendPresenceUpdate('composing')` — ephemeral typing bubble
- **Telegram**: Native `sendChatAction('typing')` — ephemeral typing indicator
- **Slack**: `:eyes:` reaction added via `setTyping(true, messageTs)`, removed via `setTyping(false)` after each
  successful output and when the container exits. `sendMessage()`/`sendBlocks()` do NOT touch the reaction — this
  prevents indicator gaps in multi-turn conversations where the container is still alive processing piped messages.
  When piped messages switch the reaction to a new message, the old reaction is removed first to prevent orphaned
  indicators. IPC-delivered messages (`send_message` tool) also clear the typing indicator, since they bypass the
  streaming output path. Reaction removal failures are logged at `warn` level for production visibility

The StatusTracker's progress reactions (received/thinking/working/done) are only sent for channels where
`hasNativeTyping` is false or undefined. Currently all channels have native indicators, so StatusTracker reactions
are disabled. The bot needs the `reactions:write` scope for the Slack `:eyes:` reaction.

## Session Management

The Claude Agent SDK stores conversation history in `.jsonl` session files under
`data/sessions/{group}/.claude/projects/-workspace-group/`. The SDK has built-in auto-compaction that triggers
when the session approaches the context window limit. Users can also send `/compact` to manually summarize history,
or `/clear` to start a fresh session.

`/clear` is handled by the agent-runner (not forwarded to the SDK) because the SDK's built-in `/clear` has
`supportsNonInteractive=false`. The agent-runner deletes the session file directly and returns `newSessionId: ''`.
The host treats empty-string session IDs as a deletion signal, calling `deleteSession()` and removing the in-memory
entry.

**Host-side safety net**: Before resuming a session, the host checks the session file size. If it exceeds 10MB,
the session is automatically cleared to prevent prompt-too-long deadlocks (where the session is too large for any
request, including `/compact`, to succeed).

## Per-Group Model Configuration

Each group can override the default model by placing a `config.json` in its group folder:

```json
{ "model": "opus" }
```

Supported aliases: `opus` → `claude-opus-4-6`, `sonnet` → `claude-sonnet-4-6`, `haiku` → `claude-haiku-4-5-20251001`.
Full model IDs are also accepted. The file is read on every container spawn (no cache), so edits take effect immediately.
The resolved model is passed as `ANTHROPIC_MODEL` env var to the container. The default model is `claude-opus-4-6` —
used when no `config.json` exists or when it has no `model` field. To change the default, edit `DEFAULT_MODEL` in
`src/group-config.ts`.

## Image Attachment Pipeline

Images are loaded into base64 on the **host** side before container spawn, not read from files inside the container.
This eliminates race conditions between attachment cleanup and container file reads. The flow:

1. Channel downloads image → `processImage()` resizes and saves to `groups/{folder}/attachments/`
2. `loadImageData()` reads each file into memory and **deletes it immediately**
3. Base64 data goes to the container via `ContainerInput.imageAttachments` (JSON over stdin)
4. Agent-runner sends data directly to Claude — no file reads needed

Both WhatsApp (`[Image: attachments/...]`) and Slack (`[Image attached: attachments/...]`) formats are parsed by
`parseImageReferences()`. Media types are inferred from file extension (not hardcoded). WhatsApp downloads retry twice
on failure with linear backoff.

## Agent-Runner Source Mount

Container agents mount `data/sessions/{group}/agent-runner-src` over `/app/src`. The source is synced from
`container/agent-runner/src/` on every container spawn, so changes to the agent-runner code take effect on the next
agent invocation without needing to rebuild the container image (the entrypoint recompiles TypeScript at runtime).

## Merging Skill Branches

Always **rebase skill branches onto current main before merging**, never merge directly. Skill branches fork from an
older main and their versions of shared files (especially `src/db.ts`) may be missing columns, fields, or migrations
added after the fork point. A direct merge can silently drop these changes during conflict resolution. Rebasing surfaces
conflicts in the skill branch where they're easier to review.

After merging any skill branch, run `npm test` and verify all tests pass before committing. The registered group
round-trip tests in `src/db.test.ts` specifically guard against dropped DB columns — if a merge breaks field persistence,
these tests will catch it.

CI enforces this automatically: skill branches with merge commits from main are rejected, and PRs whose schema version
is behind main's are blocked.

## DB Schema Versioning

Migrations are tracked in a `schema_version` table. Each migration has a version number, description, and `up()` function
in the `migrations` array in `src/db.ts`. The `runMigrations()` function checks the current version and runs only pending
migrations. Each migration preserves try-catch for idempotency (safe to re-run against DBs that already have the columns).

To add a new migration: append to the `migrations` array with the next version number. Existing DBs without the
`schema_version` table are treated as version 0 — all migrations run on first startup.

## Container Resource Limits

Containers run with `--memory 2g --cpus 2` by default. Override via environment variables:
- `CONTAINER_MEMORY_LIMIT` (default: `2g`)
- `CONTAINER_CPU_LIMIT` (default: `2`)

## MCP Servers

### Always-on MCP Servers

These MCP servers are always configured for agent containers:

- **Gmail** (`@gongrzhe/server-gmail-autoauth-mcp`) — Email read/send via Gmail API. Credentials mounted from
  `~/.gmail-mcp/` on the host to `/home/node/.gmail-mcp/` in the container. Tools allowed as `mcp__gmail__*`.
- **Google Calendar** (`@cocal/google-calendar-mcp`) — Calendar read/write via Google Calendar API. OAuth credentials
  read from `/home/node/.gmail-mcp/gcp-oauth.keys.json` (shared with Gmail). Token storage mounted from
  `~/.config/google-calendar-mcp/` on the host to `/home/node/.config/google-calendar-mcp/` in the container (writable,
  for OAuth token refresh). Tools allowed as `mcp__google-calendar__*`.

### Conditional MCP Servers

Agent containers can connect to additional MCP servers via env vars in `.env`:

- `DOCS_MCP_URL` — HTTP MCP documentation server (e.g. `http://192.168.2.106:8085/mcp`). Exposes `search_docs`,
  `query_docs`, `get_document`, `list_sources`, `reindex`. Tools are allowed as `mcp__docs__*`.
- `JOURNAL_MCP_URL` — Journal analysis MCP server (e.g. `http://192.168.2.105:8400/mcp`). Exposes
  `journal_search_entries`, `journal_get_entries_by_date`, `journal_list_entries`, `journal_get_statistics`,
  `journal_get_mood_trends`, `journal_get_topic_frequency`, `journal_ingest_entry`. Tools allowed as `mcp__journal__*`.
- `PARALLEL_API_KEY` — Parallel AI search and task MCP servers. Tools allowed as `mcp__parallel-search__*` and
  `mcp__parallel-task__*`.

These are conditional — if the env var is not set, the MCP server is not configured. Env vars are passed to
containers via `src/container-runner.ts` (explicit `-e` flags, not inherited from the process environment).

## Slash Commands

Any `\command` (or `/command`) from a channel is detected generically — no whitelist. The system has three categories:

- **SDK commands** (e.g., `/compact`, `/done`): forwarded to the SDK inside a container
- **Agent-runner commands** (`/clear`, `/skills`): handled in the agent-runner without SDK involvement (the SDK's
  built-in versions have `supportsNonInteractive=false`)
- **Intercepted commands** (`/usage`, `/status`): handled on the host via `executeHostCommand()` in `src/host-commands.ts`

All commands are detected by `extractCommand()` in `src/session-commands.ts`. Intercepted commands execute inline in the
message loop; SDK and agent-runner commands are enqueued for container processing. Backslash is normalized to forward
slash (Slack intercepts `/` as native slash commands).

**Auth model:** Session-modifying commands (`/compact`, `/clear`, `/done`) require admin access: main group,
`is_from_me`, or direct conversation groups (`requiresTrigger=false`). The `requiresTrigger=false` rule means that if
all senders in a group are trusted to talk to the agent, they're also trusted to manage its session. Read-only commands
(`/usage`, `/model`, `/skills`, `/status`) are available to any sender. Both the message loop's `closeStdin` gate and
`handleSessionCommand` must agree — read-only commands bypass auth in both places.

## Usage Tracking

The `\usage` command shows rate limit utilization with progress bars and reset times. It first tries the
`console.anthropic.com/api/oauth/usage` API using the OAuth token from `~/.claude/.credentials.json`, which returns
5-hour session, 7-day weekly, and per-model utilization percentages. If the API call fails, it falls back to
DB-stored rate limit snapshots captured from the SDK's `rate_limit_event` messages during agent queries.

Intercepted commands execute **inline** in the message loop (not deferred to `processGroupMessages`). This prevents a
race where the next poll cycle would include the command message in `allPending` and pipe it to an active container.

## Health Monitoring

Three-level health monitoring system:

1. **`/status` command** — any channel user can send `/status` to get service health: uptime, channel connectivity,
   container queue, message cursor age, scheduled task summary. Implemented in `src/host-commands.ts` via a health
   provider callback registered by the orchestrator. Health data collection is in `src/health.ts` (pure function).

2. **HTTP health endpoint** — `GET http://127.0.0.1:3002/health` returns JSON with HTTP 200 (healthy) or 503 (degraded).
   Port configurable via `HEALTH_PORT` env var. Implemented in `src/health-server.ts`.

3. **Systemd watchdog** — the message loop sends `WATCHDOG=1` every 2 seconds via `systemd-notify`. If 15 consecutive
   heartbeats are missed (30s), systemd restarts the service. Also sends `READY=1` on startup and `STOPPING=1` on
   shutdown. Requires `Type=notify`, `NotifyAccess=all`, and `WatchdogSec=30s` in the service file.
   Implemented in `src/watchdog.ts`.

4. **Smoke test** — `npx tsx scripts/smoke-test.ts` checks the health endpoint and DB for staleness. `--full` mode
   injects a test message and waits for a response. Exit code 0 = healthy, 1 = unhealthy.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the
builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run
`./container/build.sh`.
