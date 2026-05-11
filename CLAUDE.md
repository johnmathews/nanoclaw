# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for design rationale, [docs/SPEC.md](docs/SPEC.md) for the technical
spec, and [docs/index.md](docs/index.md) for the full documentation index plus source-of-truth ordering when sources
disagree.

## Where to look first

| If you're about to…                                | Start here                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Add or modify a channel                            | `src/channels/registry.ts`, then [docs/skills-as-branches.md](docs/skills-as-branches.md) for the distribution model. |
| Touch the DB or a migration                        | `src/db.ts` `migrations` array; see [DB Schema Versioning](#db-schema-versioning).                                    |
| Change credential / auth flow                      | `src/credential-proxy.ts` and [docs/credential-proxy.md](docs/credential-proxy.md) (canonical).                       |
| Add / change a slash command                       | `src/session-commands.ts`; full reference at [docs/slash-commands.md](docs/slash-commands.md) (canonical).            |
| Modify a mount or container env                    | `src/container-runner.ts`; security implications in [docs/SECURITY.md](docs/SECURITY.md).                             |
| Touch session state or compaction                  | `container/agent-runner/src/index.ts`; spec in [docs/SPEC.md](docs/SPEC.md) §9.                                       |
| Debug a runtime issue                              | `runbooks/troubleshooting.md`, then the `/debug` skill if it doesn't get you there.                                   |
| Re-auth a channel (WA/Gmail/GCal/Slack)            | [runbooks/re-auth.md](runbooks/re-auth.md).                                                                           |
| Pull from upstream                                 | [docs/skills-as-branches.md](docs/skills-as-branches.md) (rebase, never merge) and `/update-nanoclaw`.                |

## Quick Context

Single Node.js process with skill-based channel system. Channels self-register at startup. **In this fork's `main`,
Slack, WhatsApp, Telegram, and Gmail are bundled in `src/channels/`; Discord is available via the `/add-discord`
skill but not bundled.** Messages route to the Claude Agent SDK running in isolated containers (process- and
namespace-isolated on Linux Docker; per-container VM isolation available via Apple Container or Docker Sandboxes —
see [docs/SECURITY.md](docs/SECURITY.md) §1). Each group has isolated filesystem and memory.
[docs/fork-divergence.md](docs/fork-divergence.md) is the canonical index of what this fork adds on top of upstream.

## Reliability / Sturdiness

Service availability is a top design priority. NanoClaw must not break on rollout — prefer additive, behind-flag
changes over invasive refactors; keep migrations idempotent; ensure new code paths fall through safely when their
inputs are missing. The whole system is one Node process; one breakage takes down every channel.

## Testing

Every code change ships with tests. Convention is `src/<thing>.test.ts` (vitest). Bug fixes ship with a regression
test that fails before the fix and passes after. `npm test` must be green before commit; CI also runs
`npm run format:check` and the schema-version / skill-rebase guards. See `.github/workflows/ci.yml`.

## Load-bearing files (touch with care)

These files have outsized blast radius if a change goes wrong. Read them carefully, write tests, and prefer narrow
edits over rewrites:

- `src/db.ts` — schema + migrations. A wrong migration corrupts persistent state; idempotency in `up()` is mandatory.
- `src/credential-proxy.ts` — security boundary. Mistakes here can leak real OAuth tokens into containers.
- `src/mount-security.ts` — security boundary. The allowlist + colon-injection guard is what prevents container
  escape via the `-v` arg surface.
- `src/container-runner.ts` — mount layout, container env, security flags (`--security-opt no-new-privileges`,
  `--memory`, `--cpus`). Touch with the security implications in [docs/SECURITY.md](docs/SECURITY.md) in mind.
- `src/sender-allowlist.ts` — defence against compromised channel keys; per-chat allowlist semantics.

## Key Files

### Entry point and orchestration

| File                      | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| **`src/index.ts`**        | Orchestrator: state, message loop, agent invocation, startup/shutdown. |
| `src/message-loop.ts`     | Inner message-processing loop                                          |
| `src/router.ts`           | Outbound message formatting and channel dispatch                       |
| `src/group-config.ts`     | Reads/resolves per-group `config.json`                                 |
| `src/config.ts`           | Trigger pattern, paths, intervals, port defaults                       |
| `src/env.ts`              | Env-var loading helpers                                                |
| `src/logger.ts`           | Pino-style structured JSON logger                                      |

### Channels

| File                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `src/channels/registry.ts`      | Channel registry (self-registration at startup)          |
| `src/channels/slack.ts`         | Slack channel (Socket Mode)                              |
| `src/channels/whatsapp.ts`      | WhatsApp channel (baileys)                               |
| `src/channels/telegram.ts`      | Telegram channel (grammy)                                |
| `src/channels/gmail.ts`         | Gmail channel (gmail-autoauth-mcp)                       |
| `src/status-tracker.ts`         | Progress reactions for channels without native typing    |

### Containers and agent-runner

| File                                                  | Purpose                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `src/container-runner.ts`                             | Spawns containers with mounts, env, security flags               |
| `src/container-runtime.ts`                            | Docker CLI abstraction; runtime + bind-host detection            |
| `src/mount-security.ts`                               | Realpath + allowlist validation for additional mounts            |
| `container/skills/agent-browser/SKILL.md`             | Browser automation tool (available to all agents via Bash)       |

### IPC, scheduling, session

| File                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `src/ipc.ts`                    | IPC watcher and task processing                          |
| `src/task-scheduler.ts`         | Runs scheduled tasks                                     |
| `src/group-queue.ts`            | Per-group serialization, `MAX_CONCURRENT_CONTAINERS` limit |
| `src/session-cleanup.ts`        | Daily prune via `scripts/cleanup-sessions.sh`            |
| `src/session-commands.ts`       | Session + host command extraction and handling           |
| `src/host-commands.ts`          | Host-side commands (`/usage`, `/status`) — no container spawn |
| `src/image.ts`                  | Image processing, base64 loading, reference parsing      |
| `src/transcription.ts`          | Voice message transcription via OpenAI Whisper           |
| `src/remote-control.ts`         | Captures a `claude.ai/code` URL for ad-hoc remote claude access (fork-local) |

### Security boundary

| File                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `src/credential-proxy.ts`       | OAuth/API-key injection at the network boundary (fork-local) |
| `src/sender-allowlist.ts`       | Optional per-chat sender gating                          |

### Health / monitoring

| File                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `src/health.ts`                 | Pure-function health snapshot                            |
| `src/health-server.ts`          | HTTP `/health` on port 3002                              |
| `src/watchdog.ts`               | systemd watchdog integration (sd_notify)                 |

### Storage

| File                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `src/db.ts`                     | SQLite schema, migrations, all data access               |
| `store/messages.db`             | SQLite database (messages, chats, tasks, sessions, state) |
| `data/status-tracker.json`      | StatusTracker persistence (not in DB)                    |
| `data/remote-control.json`      | Remote-control session state                             |
| `groups/{name}/CLAUDE.md`       | Per-group memory (isolated)                              |
| `groups/{name}/config.json`     | Per-group config (model override, etc.)                  |

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

## Logs

Linux: `journalctl --user -u nanoclaw -f` (or `-n 100` for the last 100 lines). Format is pino-style structured
JSON. Service-level operations and rotation are documented in
[runbooks/service-management.md](runbooks/service-management.md).

## Database access

The host doesn't include the `sqlite3` CLI — use Node.js with `better-sqlite3` for one-off queries:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly: true});
console.log(db.prepare('SELECT id, sender_name, timestamp FROM messages ORDER BY timestamp DESC LIMIT 5').all());
"
```

Full query patterns, backup/restore, and migration notes in
[runbooks/database-operations.md](runbooks/database-operations.md).

## Troubleshooting

Symptom-based debugging: [runbooks/troubleshooting.md](runbooks/troubleshooting.md). Re-auth flows per channel:
[runbooks/re-auth.md](runbooks/re-auth.md). When in doubt, run `/debug` inside `claude` — it loads the
troubleshooting runbook and the recent log context.

### WhatsApp upgrade gotcha

In this fork, WhatsApp is bundled in `main` (`src/channels/whatsapp.ts`). The upstream `qwibitai/nanoclaw` v2+
removed WhatsApp from core and ships it on a separate `nanoclaw-whatsapp` remote — that recipe applies only when
pulling from upstream. See [docs/fork-divergence.md](docs/fork-divergence.md).

## WhatsApp dedicated number

The agent runs on its own WhatsApp Business account (`ASSISTANT_HAS_OWN_NUMBER=true`):

- Separate phone number (eSIM) linked via WhatsApp Business.
- No message prefix needed — `fromMe` flag distinguishes bot messages from user messages.
- Chat looks like a normal 1-on-1 conversation.
- Auth uses pairing code (`npm run auth --pairing-code --phone <number>`) — more reliable than QR in terminals.

Re-auth procedure: [runbooks/re-auth.md](runbooks/re-auth.md).

## Channel Typing Indicators

Canonical reference: [docs/slack-attachments.md §Channel Typing Indicators](docs/slack-attachments.md#channel-typing-indicators).
Quick summary: Slack/WhatsApp/Telegram declare `hasNativeTyping=true` and use their platform's native indicator;
other channels (when on the main group) get StatusTracker progress reactions instead.

## Slack threading

`thread_ts` capture, migration v6, `getThreadMessages()`, and the `send_message`/`send_blocks` `thread_id` parameter
are documented in [docs/slack-attachments.md](docs/slack-attachments.md) (canonical).

## Session Management

The Claude Agent SDK stores conversation history in `.jsonl` session files at
`data/sessions/{group}/.claude/projects/-workspace-group/` on the host. The host mounts this into the container at
`/home/node/.claude/` (the container user's `$HOME`); the SDK reads its session store from there. Auto-compaction
fires when the session approaches the context window limit. Users can also send `/compact` to manually summarize
history, or `/clear` to start a fresh session.

`/clear` is handled by the agent-runner (not forwarded to the SDK) because the SDK's built-in `/clear` has
`supportsNonInteractive=false`. The agent-runner deletes the session file directly and returns `newSessionId: ''`;
the host treats empty-string session IDs as a deletion signal.

**Host-side safety net**: Before resuming a session, the host checks the session file size. If it exceeds 10MB the
session is automatically cleared to prevent prompt-too-long deadlocks (where the session is too large for any
request, including `/compact`, to succeed).

Compaction internals (the `compact_boundary` handler vs. the `PreCompact` hook) are documented in
[docs/SPEC.md](docs/SPEC.md) §9.

## Per-group model configuration

Each group can override the default model by placing a `config.json` in its group folder:

```json
{ "model": "opus" }
```

Aliases (`opus`/`sonnet`/`haiku`) and the default model ID are defined in `src/group-config.ts` — see
`DEFAULT_MODEL_ALIASES` and `DEFAULT_MODEL` there for the authoritative current values. Full model IDs are also
accepted in `config.json`. The file is read on every container spawn (no cache), so edits take effect immediately.
The resolved model is passed as `ANTHROPIC_MODEL` env var to the container.

Groups can also set `"skipImageMultimodal": true` to prevent images from being sent as multimodal content blocks
to Claude. Images are still downloaded and their text references (`[Image attached: ...]`, `[Image: ...]`) remain
in the prompt, but the binary data is not loaded into memory or sent to the LLM. Files are cleaned up from disk
via `cleanupImageFiles()`. Useful for groups where an MCP server handles all vision/OCR work internally.

Additional mounts: a group can set `"containerConfig": { "additionalMounts": [...] }` for per-group filesystem
access:

```json
{
  "containerConfig": {
    "additionalMounts": [
      { "hostPath": "/home/john/projects/my-app", "containerPath": "/workspace/extra/my-app", "readonly": false },
      { "hostPath": "/home/john/Documents/refs",  "containerPath": "/workspace/extra/refs",   "readonly": true }
    ]
  }
}
```

Each mount is validated against the external allowlist at `~/.config/nanoclaw/mount-allowlist.json` —
non-allowlisted paths are rejected (`src/mount-security.ts`). See [docs/SECURITY.md](docs/SECURITY.md) §2.

## Image attachment pipeline

Host-side base64 loading; deep coverage in [docs/SPEC.md](docs/SPEC.md) §6 (Image Attachment Pipeline section).
Briefly: images are loaded into memory on the host before container spawn and deleted from disk immediately, then
delivered to the agent-runner via stdin — no in-container file reads.

## Agent-runner source mount

Container agents mount `data/sessions/{group}/agent-runner-src` (host) over `/app/src` (container). The source is
synced from `container/agent-runner/src/` on every container spawn so each container has a per-group copy of the
agent-runner source. **TypeScript is NOT recompiled at runtime** — the entrypoint runs `node /app/dist/index.js`,
where `dist/` was produced at image-build time by `npm run build` (`container/Dockerfile:50,64`). Changes to
`container/agent-runner/src/*.ts` require `./container/build.sh` to take effect on the next spawn.

## Merging skill branches

Always **rebase skill branches onto current main before merging**, never merge directly. Skill branches fork from
an older main and their versions of shared files (especially `src/db.ts`) may be missing columns or migrations
added after the fork point. A direct merge can silently drop these changes during conflict resolution. Rebasing
surfaces conflicts in the skill branch where they're easier to review.

After merging any skill branch, run `npm test` and verify all tests pass before committing. The registered-group
round-trip tests in `src/db.test.ts` specifically guard against dropped DB columns.

CI enforces this automatically (see `.github/workflows/ci.yml`): skill branches with merge commits from main are
rejected, and PRs whose schema version is behind main's are blocked.

## DB schema versioning

Migrations are tracked in a `schema_version` table. Each migration has a version number, description, and `up()`
function in the `migrations` array in `src/db.ts`. The `runMigrations()` function checks the current version and
runs only pending migrations. Each migration uses try/catch for idempotency (safe to re-run against DBs that
already have the columns).

To add a new migration: append to the `migrations` array with the next version number. Existing DBs without the
`schema_version` table are treated as version 0 — all migrations run on first startup.

## Container resource limits

`--memory 2g --cpus 2` by default. Override via `CONTAINER_MEMORY_LIMIT` and `CONTAINER_CPU_LIMIT` env vars.
Full container env contract in [docs/SPEC.md](docs/SPEC.md) §6.

## MCP servers

Full inventory and per-server tool lists in [docs/SPEC.md](docs/SPEC.md) §10. Quick summary:

- **Always-on:** Gmail (`mcp__gmail__*`), Google Calendar (`mcp__google-calendar__*`), in-container `nanoclaw`
  (`mcp__nanoclaw__*` — 10 tools including `schedule_task`, `send_message`, `send_blocks`, `register_group`,
  `react_to_message`, `query_reactions`).
- **Conditional via env var:** `DOCS_MCP_URL`, `JOURNAL_MCP_URL` + `JOURNAL_API_TOKEN`, `PARALLEL_API_KEY`,
  `GITHUB_TOKEN`. Absent if the var is unset.

Every channel reply flows through the `mcp__nanoclaw__send_message` tool (or `send_blocks` for Slack rich blocks);
both accept an optional `thread_id` for Slack threading.

## Slash commands

Canonical reference: [docs/slash-commands.md](docs/slash-commands.md). Source of truth: `src/session-commands.ts`.

Three categories:

- **Host-intercepted** (`/usage`, `/status`) — handled inline by `executeHostCommand()` in `src/host-commands.ts`;
  no container spawn.
- **Agent-runner-intercepted** (`/clear`, `/skills`, `/model`) — sent to the container but handled before the SDK
  query. `/clear` is here because the SDK's built-in `/clear` has `supportsNonInteractive=false`.
- **SDK-forwarded** (`/compact`, `/done`, others) — passed through to the Claude Agent SDK.

Auth model (`src/session-commands.ts:45-51`): admin commands require `isMainGroup || isFromMe || !requiresTrigger`.
Read-only commands (`/usage`, `/model`, `/skills`, `/status`) bypass that gate in both the message loop's
`closeStdin` check and `handleSessionCommand`. Backslash is normalized to forward slash (Slack intercepts `/` as a
native slash command).

### `/usage` specifics

Shows rate-limit utilization with progress bars and reset times. First tries the
`api.anthropic.com/api/oauth/usage` endpoint using the OAuth token from `~/.claude/.credentials.json`
(`src/host-commands.ts:230`); the token-refresh endpoint at `console.anthropic.com/v1/oauth/token` is hit
separately when the access token needs renewal (`src/host-commands.ts:92`). If the usage API call fails, it falls
back to DB-stored rate-limit snapshots captured from the SDK's `rate_limit_event` messages during agent queries.

Intercepted commands execute **inline** in the message loop (not deferred to `processGroupMessages`). This prevents
a race where the next poll cycle would include the command message in `allPending` and pipe it to an active
container.

## Health Monitoring

Three independent layers:

1. **`/status` command** — any channel user can send `/status` to get service health: uptime, channel connectivity,
   container queue, message cursor age, scheduled task summary. Implemented in `src/host-commands.ts` via a health
   provider callback registered by the orchestrator. Health data collection is in `src/health.ts` (pure function).

2. **HTTP health endpoint** — `GET http://127.0.0.1:3002/health` returns JSON with HTTP 200 (healthy) or 503
   (degraded). Port configurable via `HEALTH_PORT` env var. Implemented in `src/health-server.ts`.

3. **Systemd watchdog** — the message loop sends `WATCHDOG=1` every 2 seconds via `systemd-notify`. If 15 consecutive
   heartbeats are missed (30s), systemd restarts the service. Also sends `READY=1` on startup and `STOPPING=1` on
   shutdown. Requires `Type=notify`, `NotifyAccess=all`, and `WatchdogSec=30s` in the service file.

   > **Known installer gap:** `/setup` currently writes `Type=simple` with no `NotifyAccess` / `WatchdogSec`, so
   > `initWatchdog()` returns `null` and this layer is silently disabled on fresh installs until the unit file is
   > edited manually. Tracked in `journal/260511-docs-sweep-and-deferred-items.md` deferred item #1.

4. **Smoke test** — `npx tsx scripts/smoke-test.ts` checks the health endpoint and DB for staleness. `--full` mode
   injects a test message and waits for a response. Exit code 0 = healthy, 1 = unhealthy.

## Container build cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps —
the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run
`./container/build.sh`.
