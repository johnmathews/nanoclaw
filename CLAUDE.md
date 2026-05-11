# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions and
[docs/index.md](docs/index.md) for the documentation index (including source-of-truth ordering when sources disagree).

## Quick Context

Single Node.js process with skill-based channel system. Channels self-register at startup. **In this fork's `main`,
Slack, WhatsApp, Telegram, and Gmail are bundled in `src/channels/`; Discord is available via the `/add-discord`
skill but not bundled.** Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has
isolated filesystem and memory. See [docs/fork-divergence.md](docs/fork-divergence.md) for what this fork adds on
top of upstream NanoClaw.

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
| `src/credential-proxy.ts`           | OAuth/API-key injection at the network boundary (fork-local) |
| `src/container-runtime.ts`          | Docker CLI abstraction; runtime + bind-host detection      |
| `src/mount-security.ts`             | Realpath + allowlist validation for additional mounts      |
| `src/sender-allowlist.ts`           | Optional per-channel sender gating                         |
| `src/status-tracker.ts`             | Progress reactions for channels without native typing      |
| `src/message-loop.ts`               | Inner message-processing loop                              |
| `src/session-cleanup.ts`            | Daily prune of stale session artifacts                     |
| `container/skills/agent-browser/SKILL.md` | Browser automation tool (available to all agents via Bash) |

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

**WhatsApp not connecting after upgrade:** In this fork, WhatsApp is bundled in `main` (`src/channels/whatsapp.ts`).
The upstream `qwibitai/nanoclaw` v2+ removed WhatsApp from core and ships it on a separate
`https://github.com/qwibitai/nanoclaw-whatsapp.git` remote — that recipe applies only when pulling from upstream.
See [docs/fork-divergence.md](docs/fork-divergence.md) for what's bundled here vs. upstream.

## Slack Thread Support and Typing Indicators

Slack threading (`thread_ts` capture, migration v6, `getThreadMessages()`, `send_message`/`send_blocks` `thread_id`
parameter) and the per-channel typing-indicator mechanism (Slack `:eyes:` reaction; WhatsApp `sendPresenceUpdate`;
Telegram `sendChatAction`; StatusTracker per-call gating via `hasNativeTyping`) are documented in
[docs/slack-attachments.md](docs/slack-attachments.md). That doc is canonical — if it disagrees with the code, patch
it there, not here.

Note: Gmail does not declare `hasNativeTyping`, but StatusTracker is also gated to the main group, so Gmail-channel
groups typically get no progress reaction either.

## Session Management

The Claude Agent SDK stores conversation history in `.jsonl` session files at
`data/sessions/{group}/.claude/projects/-workspace-group/` on the host. The host mounts this into the container at
`/home/node/.claude/` (the container user's `$HOME`), and the SDK reads its session store from there. The SDK has
built-in auto-compaction that triggers when the session approaches the context window limit. Users can also send
`/compact` to manually summarize history, or `/clear` to start a fresh session.

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

Groups can also set `"skipImageMultimodal": true` to prevent images from being sent as multimodal content blocks
to Claude. Images are still downloaded and their text references (`[Image attached: ...]`, `[Slack image URL: ...]`)
remain in the prompt, but the binary data is not loaded into memory or sent to the LLM. Files are cleaned up from
disk via `cleanupImageFiles()`. This is useful for groups where an MCP server handles all vision/OCR work internally.

## Image Attachment Pipeline

Images are loaded into base64 on the **host** side before container spawn, not read from files inside the container.
This eliminates race conditions between attachment cleanup and container file reads. The flow:

1. Channel downloads image → `processImage()` resizes and saves to `groups/{folder}/attachments/`
2. `loadImageData()` reads each file into memory and **deletes it immediately** (unless `skipImageMultimodal` is set,
   in which case `cleanupImageFiles()` deletes without reading)
3. Base64 data goes to the container via `ContainerInput.imageAttachments` (JSON over stdin)
4. Agent-runner sends data directly to Claude — no file reads needed

Both WhatsApp (`[Image: attachments/...]`) and Slack (`[Image attached: attachments/...]`) formats are parsed by
`parseImageReferences()`. Media types are inferred from file extension (not hardcoded). WhatsApp downloads retry twice
on failure with linear backoff.

## Agent-Runner Source Mount

Container agents mount `data/sessions/{group}/agent-runner-src` over `/app/src`. The source is synced from
`container/agent-runner/src/` on every container spawn so each container has a per-group copy of the agent-runner
source. **TypeScript is NOT recompiled at runtime** — the entrypoint runs `node /app/dist/index.js`, where `dist/`
was produced at image-build time by `npm run build` (`container/Dockerfile:50,64`). Changes to
`container/agent-runner/src/*.ts` require `./container/build.sh` to take effect on the next spawn.

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

### In-container MCP server (nanoclaw)

The agent-runner registers an in-container MCP server named `nanoclaw` exposing tools for scheduling and IPC:
`schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`, `send_blocks`,
`register_group`. Source: `container/agent-runner/src/ipc-mcp-stdio.ts`. Tools are allowed as `mcp__nanoclaw__*`.
Every channel reply flows through `send_message` (or `send_blocks` for Slack rich blocks); both accept an optional
`thread_id` for Slack threading.

### Conditional MCP Servers

Agent containers can connect to additional MCP servers via env vars in `.env`:

- `DOCS_MCP_URL` — HTTP MCP documentation server. Tools allowed as `mcp__docs__*`.
- `JOURNAL_MCP_URL` — Journal analysis MCP server. Tools allowed as `mcp__journal__*`. The server exposes a large
  and growing tool surface (search, statistics, mood trends, entity extraction, ingest from text/media/multi-page,
  fitness correlations, etc.) — the wildcard allowlist forwards them all. Auth: set `JOURNAL_API_TOKEN` to the
  `jnl_...` API key — sent as `Authorization: Bearer <token>`.
- `PARALLEL_API_KEY` — Parallel AI search and task MCP servers. Tools allowed as `mcp__parallel-search__*` and
  `mcp__parallel-task__*`.
- `GITHUB_TOKEN` — Passed through to the container env when set; consumed by tools that hit the GitHub API.

These are conditional — if the env var is not set, the MCP server is not configured. Env vars are passed to
containers via `src/container-runner.ts` (explicit `-e` flags, not inherited from the process environment).

## Slash Commands

Canonical reference: [docs/slash-commands.md](docs/slash-commands.md). Source of truth:
`src/session-commands.ts`.

Three categories, briefly:

- **Host-intercepted** (`/usage`, `/status`) — handled inline by `executeHostCommand()` in `src/host-commands.ts`;
  no container spawn.
- **Agent-runner-intercepted** (`/clear`, `/skills`, `/model`) — sent to the container but handled before the SDK
  query. `/clear` is here because the SDK's built-in `/clear` has `supportsNonInteractive=false`.
- **SDK-forwarded** (`/compact`, `/done`, others) — passed through to the Claude Agent SDK.

Auth model (`src/session-commands.ts:45-51`): admin commands require `isMainGroup || isFromMe || !requiresTrigger`.
Read-only commands (`/usage`, `/model`, `/skills`, `/status`) bypass that gate in both the message loop's
`closeStdin` check and `handleSessionCommand`. Backslash is normalized to forward slash (Slack intercepts `/` as a
native slash command).

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
