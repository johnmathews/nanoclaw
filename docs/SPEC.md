# NanoClaw Technical Specification

This document is the authoritative technical reference for NanoClaw. For setup and operations, see
[../runbooks/](../runbooks/). For philosophy and rationale, see [REQUIREMENTS.md](REQUIREMENTS.md). For the trust
model see [SECURITY.md](SECURITY.md).

Authoritative code references in this doc point at the current `main` of this fork; if reality and this doc diverge,
the code wins — patch this doc.

---

## 1. Overview

A single Node.js process (`src/index.ts`) receives messages from chat channels, spawns ephemeral containers running
the Claude Agent SDK, and routes responses back. Each registered group gets an isolated filesystem, its own session
history, and access to a shared set of MCP tools.

```
Channel inbound ──► SQLite messages table ──► message loop
                                                   │
                                                   ▼
                                            Group queue (≤5 concurrent)
                                                   │
                                                   ▼
                                            Container spawn (Docker)
                                                   │
                                            ┌──────┴──────┐
                                            │ Agent SDK   │  ── streamed output ──► channel
                                            │  + MCP      │  ── IPC files       ──► host
                                            └─────────────┘
```

### Host vs. Container

At a glance, where each major piece of NanoClaw runs:

| Component                       | Host | Container | Notes                                                            |
| ------------------------------- | ---- | --------- | ---------------------------------------------------------------- |
| Orchestrator (`src/index.ts`)   | ✓    |           | Single Node process                                              |
| Channels (Slack/WA/Tg/Gmail)    | ✓    |           | Live WebSocket / poll connections to platforms                   |
| Credential proxy                | ✓    |           | HTTP server on docker0 (Linux) or 127.0.0.1 (macOS/WSL)          |
| Status tracker                  | ✓    |           | Reaction calls go out via host's channel client                  |
| Health server, watchdog         | ✓    |           | systemd sd_notify; HTTP on `:3002`                               |
| DB (`store/messages.db`)        | ✓    |           | SQLite, accessed only by host                                    |
| Agent-runner                    |      | ✓         | `/app/dist/index.js` — drives the SDK inside each container      |
| Claude Agent SDK                |      | ✓         | Invoked by agent-runner                                          |
| Bash, tool calls, file ops      |      | ✓         | Anything an agent does runs in the container                     |
| Gmail / Calendar MCP servers    |      | ✓         | spawned per-container by agent-runner                            |
| `nanoclaw` MCP server (in-proc) |      | ✓         | bundled into agent-runner                                        |
| Whisper transcription           | ✓    |           | Host-side; uses `OPENAI_API_KEY` (not forwarded to containers)   |
| Scheduled task evaluation       | ✓    |           | Host runs the scheduler; tasks themselves run in spawned containers |

## 2. Components

| Component         | File                       | Purpose                                              |
| ----------------- | -------------------------- | ---------------------------------------------------- |
| Orchestrator      | `src/index.ts`             | Message loop, startup/shutdown, session management   |
| Container Runner  | `src/container-runner.ts`  | Spawns containers with mounts and env vars           |
| Container Runtime | `src/container-runtime.ts` | Docker CLI abstraction; runtime detection            |
| Group Queue       | `src/group-queue.ts`       | Per-group serialization, retry with backoff          |
| Channel Registry  | `src/channels/registry.ts` | Self-registering channel factory                     |
| IPC               | `src/ipc.ts`               | File-based host↔container communication              |
| Router            | `src/router.ts`            | Outbound message formatting and channel dispatch     |
| Task Scheduler    | `src/task-scheduler.ts`    | Cron / interval / one-shot scheduled tasks           |
| Credential Proxy  | `src/credential-proxy.ts`  | OAuth/API-key injection at the network boundary      |
| Group Config      | `src/group-config.ts`      | Per-group `config.json` resolution                   |
| Image Pipeline    | `src/image.ts`             | Host-side multimodal base64 loading                  |
| Transcription     | `src/transcription.ts`     | Whisper API client for voice                         |
| Host Commands     | `src/host-commands.ts`     | `/usage`, `/status` — answered without a container   |
| Session Commands  | `src/session-commands.ts`  | Slash-command extraction and dispatch                |
| Mount Security    | `src/mount-security.ts`    | External allowlist validation                        |
| Sender Allowlist  | `src/sender-allowlist.ts`  | Optional per-chat sender gating — see [fork-divergence.md](fork-divergence.md#sender-allowlist) for canonical reference |
| Status Tracker    | `src/status-tracker.ts`    | Progress reactions; state at `data/status-tracker.json` |
| Remote Control    | `src/remote-control.ts`    | Captures a `claude.ai/code` URL session for ad-hoc remote claude access; state at `data/remote-control.json` |
| Health            | `src/health.ts`            | Pure-function health snapshot                        |
| Health Server     | `src/health-server.ts`     | HTTP `GET /health` on port 3002                      |
| Watchdog          | `src/watchdog.ts`          | systemd `WATCHDOG=1` every 2s                        |
| Session Cleanup   | `src/session-cleanup.ts`   | Daily prune via `scripts/cleanup-sessions.sh` (24h interval) |
| DB                | `src/db.ts`                | SQLite schema, migrations, all data access           |

## 3. Channels

Channels are skills that self-register at startup via `src/channels/registry.ts`. The contract is the
`Channel` interface (`src/types.ts`):

```ts
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, threadTs?: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  hasNativeTyping?: boolean;
  setTyping?(jid: string, isTyping: boolean, messageTs?: string): Promise<void>;
  updateWorkingIndicator?(jid: string, text: string): void;
  syncGroups?(force: boolean): Promise<void>;
  sendReaction?(chatJid: string, messageKey: {...}, emoji: string): Promise<void>;
  reactToLatestMessage?(chatJid: string, emoji: string): Promise<void>;
}
```

- `connect()` must always settle — resolve on first successful connection, reject on auth failure. A failing channel
  must not exit the process (see [journal/260420-journal-token-and-whatsapp-isolation.md](../journal/260420-journal-token-and-whatsapp-isolation.md)).
- `sendMessage()` may be called with a `threadTs`; non-threaded channels ignore it.
- The interaction between `hasNativeTyping`, the StatusTracker, and the main-group gate is documented canonically
  in [slack-attachments.md §Channel Typing Indicators](slack-attachments.md#channel-typing-indicators). Quick
  summary: Slack/WhatsApp/Telegram use native indicators; other channels (when on the main group) get StatusTracker
  reactions.

### Currently supported

| Channel  | Auth                       | Implementation                | Notes                                            |
| -------- | -------------------------- | ----------------------------- | ------------------------------------------------ |
| Slack    | Socket Mode                | `src/channels/slack.ts`       | Thread support, image vision, PDF handoff        |
| Gmail    | OAuth (gmail-autoauth-mcp) | `src/channels/gmail.ts`       | Both a channel and an MCP tool                   |
| WhatsApp | Pairing code (baileys)     | `src/channels/whatsapp.ts`    | Bundled in this fork's `main`. Upstream `qwibitai/nanoclaw` v2+ moved WhatsApp to a separate `nanoclaw-whatsapp` remote — see [fork-divergence.md](fork-divergence.md). |
| Telegram | Bot token                  | `src/channels/telegram.ts`    | Bundled in this fork. Optional agent-swarm mode via `/add-telegram-swarm`. |
| Discord  | Bot                        | `/add-discord` skill          | Not bundled — opt in via skill.                  |

## 4. Message Lifecycle

1. **Inbound** — a channel's event handler builds a `NewMessage` and writes it to the `messages` table:
   ```ts
   interface NewMessage {
     id: string; chat_jid: string; sender: string; sender_name: string;
     content: string; timestamp: string;
     is_from_me?: boolean; is_bot_message?: boolean;
     thread_ts?: string;          // Slack threading
     reply_to_message_id?: string; reply_to_message_content?: string; reply_to_sender_name?: string;
   }
   ```
2. **Trigger / authorization** — the message loop (`src/index.ts`, `POLL_INTERVAL = 2000`) pulls new messages,
   checks `requiresTrigger` on the group and matches `TRIGGER_PATTERN` (`/^@<assistant>\b/i`, regex-escaped). Direct
   conversations (`requiresTrigger=false`) skip the trigger check. Senders are checked against the optional
   `sender-allowlist.json`.
3. **Slash-command detection** — `extractCommand()` in `session-commands.ts` identifies `/command` and `\command`
   (Slack swallows `/`). Commands route three ways:
   - **Intercepted host commands** (`/usage`, `/status`) — handled inline via `executeHostCommand()`, no container.
   - **Agent-runner commands** (`/clear`, `/skills`) — sent to the container but handled by `agent-runner` before
     touching the SDK.
   - **SDK commands** (everything else) — forwarded to the SDK inside the container.
4. **Group queue** — `group-queue.ts` serializes per-group container runs (`MAX_CONCURRENT_CONTAINERS` total,
   default 5). If a container is already alive for the group, the new messages are piped to its stdin instead of
   spawning a new one.
5. **Container spawn** — `container-runner.ts` builds the docker args and starts the container. Image:
   `CONTAINER_IMAGE` (default `nanoclaw-agent:latest`).
6. **Streaming output** — the agent-runner writes JSON-lines to stdout. The host's stream parser dispatches by
   message type (text → channel; rate_limit_event → DB; compact_boundary → archive; etc.).
7. **Cursor advance** — `lastAgentTimestamp[chatJid]` is updated to the message just processed. On container error,
   the cursor is **restored** to its pre-run value (`index.ts:510`) so retries don't lose messages.

## 5. Groups & Registration

Groups are registered in the `registered_groups` table:

```ts
interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: {
    additionalMounts?: AdditionalMount[];
    timeout?: number;  // ms
  };
  requiresTrigger?: boolean;  // default true; false = direct-conversation
  isMain?: boolean;           // exactly one main group, has admin privileges
}
```

- Each group has a folder under `groups/<folder>/` with its own `CLAUDE.md`.
- Per-group `config.json` can override the model (`opus` | `sonnet` | `haiku` | full model ID) and set
  `"skipImageMultimodal": true`. Read on every container spawn — no caching, so edits take effect immediately.
- `isMain` is preserved across re-registration (`register_group` cannot strip a group of its main status).
  `requiresTrigger` falls back to the previous value only when the re-register payload omits it; an explicit value
  in the payload still wins (`src/ipc.ts:545-553`).
- IPC tool `register_group` lets main register new groups.

## 6. Container Model

Each agent invocation spawns a Docker container with the following layout:

| Container path               | Mount source                                    | Mode | Group scope             |
| ---------------------------- | ----------------------------------------------- | ---- | ----------------------- |
| `/workspace/group`           | `groups/<folder>/`                              | rw   | all                     |
| `/home/node/.claude`         | `data/sessions/<group>/.claude/`                | rw   | all                     |
| `/workspace/project`         | project root                                    | ro   | main only               |
| `/workspace/project/store`   | `store/`                                        | rw   | main only               |
| `/workspace/global`          | `groups/global/`                                | rw (main) / ro (non-main) | all      |
| `/workspace/extra/<name>`    | `containerConfig.additionalMounts`              | configurable, allowlist-validated | configurable |
| `/app/src` (agent-runner)    | `data/sessions/<group>/agent-runner-src/`       | rw   | all (synced each spawn) |
| `/home/node/.gmail-mcp`      | `~/.gmail-mcp/`                                 | rw   | all                     |
| `/home/node/.config/google-calendar-mcp` | same on host                        | rw   | all                     |
| `/workspace/project/.env`    | `/dev/null` (shadow)                            | ro   | main only               |

Mount-source paths in the table above are relative to the project root on the host (the directory where `npm start`
or the systemd unit runs).

Container env vars set on the host side in `container-runner.ts`:

- `ANTHROPIC_BASE_URL=http://<host-gateway>:CREDENTIAL_PROXY_PORT` — point SDK at the proxy
- `ANTHROPIC_API_KEY=placeholder` **or** `CLAUDE_CODE_OAUTH_TOKEN=placeholder` — depending on detected auth mode
- `ANTHROPIC_MODEL=<resolved model>` — from per-group `config.json` or default
- `NANOCLAW_GROUP=<group folder>` — used by `/status` for context
- Conditional: `DOCS_MCP_URL`, `JOURNAL_MCP_URL`, `JOURNAL_API_TOKEN`, `PARALLEL_API_KEY`, `GITHUB_TOKEN`

Container env vars set inside the container by the agent-runner (not host-side):

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000` — auto-compaction threshold, set unconditionally by
  `container/agent-runner/src/index.ts:592`. Not operator-configurable via host env var; the agent-runner overwrites
  any host value.

`OPENAI_API_KEY` is read on the host (Whisper transcription via `src/transcription.ts`) and is **not** forwarded into
containers.

Resource limits: `--memory CONTAINER_MEMORY_LIMIT` (default `2g`), `--cpus CONTAINER_CPU_LIMIT` (default `2`).

Idle vs hard timeouts: `IDLE_TIMEOUT` (30 min default) starts the graceful shutdown; the hard timeout is
`max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30_000)` — all in milliseconds — guaranteeing a grace window for the
container to flush before SIGKILL.

### Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps —
the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run
`./container/build.sh`.

### Image Attachment Pipeline (host-side)

Images are loaded into base64 on the host before container spawn, not read from files inside the container.
This eliminates race conditions between attachment cleanup and container file reads:

1. Channel downloads image → `processImage()` resizes and saves to `groups/<folder>/attachments/`.
2. `loadImageData()` in `src/image.ts` reads each file into memory and deletes it immediately (unless
   `skipImageMultimodal` is set in the group's `config.json`, in which case `cleanupImageFiles()` deletes without
   reading).
3. Base64 bytes go to the container via `ContainerInput.imageAttachments` (JSON over stdin).
4. The agent-runner sends bytes directly to Claude as multimodal content blocks; no file reads in-container.

Both Slack (`[Image attached: ...]`) and WhatsApp (`[Image: ...]`) formats are parsed by `parseImageReferences()`.
Media types inferred from file extension, not hardcoded. WhatsApp downloads retry twice with linear backoff.

## 7. Credential Proxy

Implementation: [`src/credential-proxy.ts`](../src/credential-proxy.ts). Started in `src/index.ts:984` before any
channel connects.

| Mode      | Selected when (.env)                                  | Container placeholder              |
| --------- | ----------------------------------------------------- | ---------------------------------- |
| api-key   | `ANTHROPIC_API_KEY` set                               | `ANTHROPIC_API_KEY=placeholder`    |
| oauth     | No API key; `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` set | `CLAUDE_CODE_OAUTH_TOKEN=placeholder` |

Containers are spawned with `ANTHROPIC_BASE_URL=http://<host-gateway>:CREDENTIAL_PROXY_PORT` (default 3001).

For request flow, OAuth exchange dance, bind-host detection, configuration, testing, strengths/weaknesses, and
improvement ideas, see **[credential-proxy.md](credential-proxy.md)**. For trust-model implications see
[SECURITY.md §5](SECURITY.md#5-credential-isolation-credential-proxy). For decision rationale see
[journal/260511-add-credential-proxy-oauth.md](../journal/260511-add-credential-proxy-oauth.md).

## 8. Slash Commands

Detected generically by `extractCommand()` in `src/session-commands.ts` — no whitelist. Routing:

| Category        | Examples                  | Handled by                  | Auth                                  |
| --------------- | ------------------------- | --------------------------- | ------------------------------------- |
| Intercepted     | `/usage`, `/status`       | host (`host-commands.ts`)   | Read-only — any sender                |
| Agent-runner    | `/clear`, `/skills`       | agent-runner (no SDK)       | `/clear` admin-only; `/skills` open   |
| SDK             | `/compact`, `/done`, ...  | Claude Agent SDK            | `/compact`, `/done` admin-only        |

**Admin** = main group, `is_from_me`, or `requiresTrigger=false` group. `/clear` is handled in the agent-runner
because the SDK's built-in `/clear` declares `supportsNonInteractive=false`. The agent-runner deletes the session
file and returns `newSessionId: ''`; the host treats empty as a deletion signal.

Backslash is normalized to forward slash (Slack intercepts `/` as a native slash command).

## 9. Session Management

Session files live at `data/sessions/<group>/.claude/projects/-workspace-group/<session-id>.jsonl`. The host mounts
this directory into the container at `/home/node/.claude/` (the container user's `$HOME`), where the SDK looks for
its session store.

Cleanup safety nets:

- **Auto-compaction** at `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000` tokens — handled by the SDK.
  - The `compact_boundary` SDK message is intercepted in the agent-runner at
    `container/agent-runner/src/index.ts:472`, where the handler logs the trigger and pre-compaction token count.
  - Transcript archiving is done by a separate `PreCompact` hook at
    `container/agent-runner/src/index.ts:165-205`, which fires *before* the SDK rewrites session state. The two
    code paths are independent — the line-472 handler doesn't archive.
- **10MB host-side limit** — before resuming, if the session file exceeds 10MB, the host clears it. This avoids
  prompt-too-long deadlocks where even `/compact` can't fit a single request.
- **Daily prune** — `src/session-cleanup.ts` shell-execs `scripts/cleanup-sessions.sh` at 24-hour intervals.
  The script removes session artifacts under `data/sessions/<group>/` that exceed the staleness threshold defined
  in that script.

`resumeSessionAt: <lastAssistantUuid>` is set on every resume to pin the branch (`agent-runner/src/index.ts:359`),
defending against the stale-branch picks investigated in [runbooks/troubleshooting.md](../runbooks/troubleshooting.md#session-transcript-branching).

## 10. MCP Servers

### Always-on

- **Gmail** — `@gongrzhe/server-gmail-autoauth-mcp`. Tools `mcp__gmail__*`. Credentials at `~/.gmail-mcp/` mounted rw.
- **Google Calendar** — `@cocal/google-calendar-mcp`. Tools `mcp__google-calendar__*`. Shares Gmail OAuth credentials; token storage at `~/.config/google-calendar-mcp/` mounted rw.
- **nanoclaw** — in-container MCP server. Implemented in `container/agent-runner/src/ipc-mcp-stdio.ts` with 10
  `server.tool(...)` registrations: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`,
  `send_message`, `send_blocks`, `register_group`, `react_to_message`, `query_reactions`. Tools allowed as
  `mcp__nanoclaw__*`.

### Conditional (HTTP, configured via env var)

| Env var               | Server                  | Tools allowed             |
| --------------------- | ----------------------- | ------------------------- |
| `DOCS_MCP_URL`        | Docs server             | `mcp__docs__*`            |
| `JOURNAL_MCP_URL` + `JOURNAL_API_TOKEN` | Journal | `mcp__journal__*`         |
| `PARALLEL_API_KEY`    | Parallel AI search/task | `mcp__parallel-search__*`, `mcp__parallel-task__*` |

Conditional MCPs absent if the env var is unset.

## 11. Scheduled Tasks

Implementation: `src/task-scheduler.ts`, `SCHEDULER_POLL_INTERVAL = 60000`. Stored in `scheduled_tasks`:

```ts
interface ScheduledTask {
  id: string; group_folder: string; chat_jid: string;
  prompt: string; script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null; last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}
```

- `context_mode: 'group'` resumes the group's session; `'isolated'` starts fresh.
- `script` (optional) runs a JS one-liner; otherwise `prompt` is sent through the agent.
- Run history is logged in `task_run_logs` (status + duration + error).

## 12. IPC

File-based, in `data/ipc/<group>/`:

- `messages/` — outbound from agent (`send_message`, `send_blocks`)
- `tasks/` — task ops (`schedule_task`, `list_tasks`, ...)

The host polls these directories every `IPC_POLL_INTERVAL = 1000ms`. JSON file appears → host parses → action taken
→ file deleted. This avoids network IPC and works cleanly within Docker mount semantics.

## 13. Database

SQLite at `store/messages.db`, WAL mode. All access through `src/db.ts`. Schema is versioned via the
`schema_version` table with idempotent migrations.

| Table                | Purpose                                         |
| -------------------- | ----------------------------------------------- |
| `messages`           | All inbound messages across channels (incl. `thread_ts`) |
| `chats`              | Chat/group metadata                             |
| `registered_groups`  | Group → folder mapping, trigger config, isMain  |
| `sessions`           | Group → Claude session ID mapping               |
| `scheduled_tasks`    | Cron/interval/once tasks                        |
| `task_run_logs`      | Execution history                               |
| `reactions`          | Emoji reactions on messages                     |
| `rate_limits`        | Anthropic API rate limit snapshots              |
| `router_state`       | KV: `lastAgentTimestamp`, message cursor, etc.  |
| `schema_version`     | Migration tracking                              |

StatusTracker state is **not** in this DB — it persists to a separate JSON file at `data/status-tracker.json`
(`src/status-tracker.ts:67-72`). Remote-control session state is similarly file-based, at `data/remote-control.json`.

To add a migration: append to `migrations` in `src/db.ts` with the next version. Each migration's `up()` should be
idempotent.

## 14. Health & Monitoring

Three independent layers:

1. **HTTP** — `GET http://127.0.0.1:3002/health` returns JSON. HTTP 200 healthy, 503 degraded. Port via `HEALTH_PORT`.
2. **Systemd watchdog** — `WATCHDOG=1` every 2s; 15 missed beats → restart (`src/watchdog.ts`). Requires
   `Type=notify`, `NotifyAccess=all`, `WatchdogSec=30s` in the unit file.
   > **Known installer gap:** `/setup` currently writes `Type=simple` (no `NotifyAccess`, no `WatchdogSec`), so
   > `initWatchdog()` returns `null` and this layer is silently disabled on fresh installs until the unit file is
   > edited manually. See `journal/260511-docs-sweep-and-deferred-items.md` deferred item #1.
3. **`/status` chat command** — same data as the HTTP endpoint, surfaced into any channel.

Plus `npx tsx scripts/smoke-test.ts` for CI-style checks (`--full` injects a test message and waits for response).

## 15. Configuration (Environment Variables)

All values read from `.env` or `process.env`. Secrets stay in `.env` and are loaded only by the credential proxy.

| Variable                       | Default                      | Notes                                  |
| ------------------------------ | ---------------------------- | -------------------------------------- |
| `ASSISTANT_NAME`               | `agent`                      | Trigger word: `@<name>`                |
| `ASSISTANT_HAS_OWN_NUMBER`     | `false`                      | WhatsApp dedicated number mode         |
| `ANTHROPIC_API_KEY`            | —                            | Selects api-key auth mode if set       |
| `CLAUDE_CODE_OAUTH_TOKEN`      | —                            | Selects OAuth mode (Max subscription)  |
| `ANTHROPIC_BASE_URL`           | https://api.anthropic.com    | Proxy upstream (advanced)              |
| `CREDENTIAL_PROXY_PORT`        | `3001`                       |                                        |
| `CREDENTIAL_PROXY_HOST`        | auto-detect                  | macOS/WSL: `127.0.0.1`; Linux: docker0 |
| `HEALTH_PORT`                  | `3002`                       |                                        |
| `CONTAINER_IMAGE`              | `nanoclaw-agent:latest`      |                                        |
| `CONTAINER_TIMEOUT`            | `1800000` (30 min, ms)       | Hard timeout (ms)                      |
| `CONTAINER_MAX_OUTPUT_SIZE`    | `10485760` (10 MB, bytes)    |                                        |
| `CONTAINER_MEMORY_LIMIT`       | `2g`                         | Docker `--memory` syntax               |
| `CONTAINER_CPU_LIMIT`          | `2` (cores)                  | Docker `--cpus` syntax                 |
| `IDLE_TIMEOUT`                 | `1800000` (30 min, ms)       | Idle shutdown threshold                |
| `MAX_CONCURRENT_CONTAINERS`    | `5` (containers)             |                                        |
| `MAX_MESSAGES_PER_PROMPT`      | `10` (messages)              |                                        |
| `DOCS_MCP_URL`                 | —                            | Optional MCP                           |
| `JOURNAL_MCP_URL`              | —                            | Optional MCP                           |
| `JOURNAL_API_TOKEN`            | —                            | Required if journal URL is set         |
| `PARALLEL_API_KEY`             | —                            | Optional MCP                           |
| `GITHUB_TOKEN`                 | —                            | Passed through for GitHub tools        |
| `OPENAI_API_KEY`               | —                            | Host-side Whisper transcription. Not forwarded into containers. |
| `LOG_LEVEL`                    | `info`                       | Host log level; also passed to agent-runner |
| `TZ`                           | system                       | Host process timezone for cron evaluation; containers have an independent TZ. |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `WHATSAPP_*`, `TELEGRAM_BOT_TOKEN`, etc. | — | Channel-specific |

Channel-specific keys vary by skill — see each `/add-*` skill's SKILL.md for the full list.

## 16. Directory Layout

```
nanoclaw/
├── src/                      # Host TypeScript
│   ├── channels/             # Slack, Gmail, WhatsApp, Telegram (and skill-installed channels)
│   ├── credential-proxy.ts
│   ├── container-runner.ts
│   ├── container-runtime.ts
│   ├── group-queue.ts
│   ├── task-scheduler.ts
│   ├── db.ts                 # Schema + migrations
│   └── ... (see Components table)
├── container/
│   ├── Dockerfile
│   ├── build.sh
│   ├── agent-runner/
│   │   └── src/index.ts      # In-container SDK driver
│   └── skills/               # Available to all agents (e.g. agent-browser/SKILL.md)
├── store/messages.db         # SQLite (host only)
├── data/
│   ├── sessions/<group>/     # Claude session JSONLs
│   └── ipc/<group>/          # IPC files
├── groups/
│   ├── global/               # Shared memory
│   ├── main/                 # Main group runtime data
│   └── <channel>_<id>/       # Per-channel groups
├── docs/                     # Design docs (you are here)
├── runbooks/                 # Operational runbooks
├── journal/                  # Decision/change log
├── scripts/                  # smoke-test.ts, cleanup-sessions.sh, ...
├── .claude/skills/           # User-facing slash commands
└── .env                      # Secrets (never committed, shadowed in containers)
```

## 17. Deployment

- **Linux (systemd)** — `~/.config/systemd/user/nanoclaw.service`. Created by `/setup`. Requires
  `Type=notify`, `NotifyAccess=all`, `WatchdogSec=30s`.
- **macOS (launchd)** — `~/Library/LaunchAgents/com.nanoclaw.plist`. No native watchdog; rely on health endpoint.

Process model: single Node.js process; containers are children. Restart-safe (cursor persists, sessions persist).

## 18. Versioning

This is `main` of a fork; upstream is `qwibitai/nanoclaw`. Fork-local changes (notably the credential proxy and
OAuth support) are documented in the journal — see
[journal/260511-add-credential-proxy-oauth.md](../journal/260511-add-credential-proxy-oauth.md). When pulling
upstream, use `/update-nanoclaw` or follow [runbooks/upstream-sync.md](../runbooks/upstream-sync.md).
