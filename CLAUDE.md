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
| `src/host-commands.ts`              | Host-side commands (/usage) — no container spawn needed    |
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

## Channel Typing Indicators

Channels declare `hasNativeTyping = true` if they have built-in typing/working indicators. This prevents the
StatusTracker from sending redundant emoji reactions (which can also cause feedback loops).

- **WhatsApp**: Native `sendPresenceUpdate('composing')` — ephemeral typing bubble
- **Telegram**: Native `sendChatAction('typing')` — ephemeral typing indicator
- **Slack**: `:eyes:` reaction added via `setTyping(true, messageTs)`, removed via `setTyping(false)` after each
  successful output and when the container exits. `sendMessage()`/`sendBlocks()` do NOT touch the reaction — this
  prevents indicator gaps in multi-turn conversations where the container is still alive processing piped messages

The StatusTracker's progress reactions (received/thinking/working/done) are only sent for channels where
`hasNativeTyping` is false or undefined. Currently all channels have native indicators, so StatusTracker reactions
are disabled. The bot needs the `reactions:write` scope for the Slack `:eyes:` reaction.

## Session Management

The Claude Agent SDK stores conversation history in `.jsonl` session files under
`data/sessions/{group}/.claude/projects/-workspace-group/`. The SDK has built-in auto-compaction that triggers
when the session approaches the context window limit. Users can also send `/compact` to manually summarize history,
or `/clear` to start a fresh session.

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

## Optional MCP Servers

Agent containers can connect to external MCP servers via env vars in `.env`:

- `DOCS_MCP_URL` — HTTP MCP documentation server (e.g. `http://192.168.2.106:8085/mcp`). Exposes `search_docs`,
  `query_docs`, `get_document`, `list_sources`, `reindex`. Tools are allowed as `mcp__docs__*`.
- `PARALLEL_API_KEY` — Parallel AI search and task MCP servers. Tools allowed as `mcp__parallel-search__*` and
  `mcp__parallel-task__*`.

These are conditional — if the env var is not set, the MCP server is not configured. Env vars are passed to
containers via `src/container-runner.ts` (explicit `-e` flags, not inherited from the process environment).

## Slash Commands

Any `\command` (or `/command`) from a channel is detected generically — no whitelist. The system has two categories:

- **SDK commands** (e.g., `/compact`, `/clear`, `/done`): forwarded to the SDK inside a container
- **Intercepted commands** (`/usage`): handled on the host via `executeHostCommand()` in `src/host-commands.ts`

All commands are detected by `extractCommand()` in `src/session-commands.ts`. Intercepted commands execute inline in the
message loop; SDK commands are enqueued for container processing. Backslash is normalized to forward slash (Slack
intercepts `/` as native slash commands).

**Auth model:** Session-modifying commands (`/compact`, `/clear`, `/done`) require admin access (main group or
`is_from_me`). Read-only commands (`/usage`, `/model`, `/skills`, `/status`) are available to any sender. Both the
message loop's `closeStdin` gate and `handleSessionCommand` must agree — read-only commands bypass auth in both places.

## Usage Tracking

The `\usage` command shows rate limit utilization with progress bars and reset times. It first tries the
`console.anthropic.com/api/oauth/usage` API using the OAuth token from `~/.claude/.credentials.json`, which returns
5-hour session, 7-day weekly, and per-model utilization percentages. If the API call fails, it falls back to
DB-stored rate limit snapshots captured from the SDK's `rate_limit_event` messages during agent queries.

Intercepted commands execute **inline** in the message loop (not deferred to `processGroupMessages`). This prevents a
race where the next poll cycle would include the command message in `allPending` and pipe it to an active container.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the
builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run
`./container/build.sh`.
