# Architecture Overview

A single Node.js process receives messages from chat channels, spawns ephemeral Docker containers running Claude agents,
and routes responses back. Every agent gets an isolated filesystem, its own session history, and access to MCP tools.

## Message Flow

```
Channel (Slack/WhatsApp/...)
    │
    ▼
Message stored in SQLite ──► Message loop (polls every 2s)
                                    │
                                    ▼
                              Group queue (max 5 concurrent containers)
                                    │
                                    ▼
                              Container spawned (Docker)
                              ├── Agent-runner receives prompt via stdin
                              ├── Claude Agent SDK processes query
                              ├── MCP tools available (Gmail, Calendar, etc.)
                              └── Output streamed back via stdout + IPC
                                    │
                                    ▼
                              Response routed to channel
```

## Core Components

| Component         | File                       | Purpose                                              |
| ----------------- | -------------------------- | ---------------------------------------------------- |
| Orchestrator      | `src/index.ts`             | Message loop, startup/shutdown, session management   |
| Container Runner  | `src/container-runner.ts`  | Spawns Docker containers with correct mounts and env |
| Container Runtime | `src/container-runtime.ts` | Docker CLI abstraction (start/stop/cleanup)          |
| Group Queue       | `src/group-queue.ts`       | Per-group concurrency control, retry with backoff    |
| Channel Registry  | `src/channels/registry.ts` | Self-registering channel factory                     |
| IPC               | `src/ipc.ts`               | File-based communication between host and containers |
| Task Scheduler    | `src/task-scheduler.ts`    | Cron/interval/one-shot scheduled tasks               |
| Credential Proxy  | `src/credential-proxy.ts`  | Injects API keys without exposing them to containers |
| Health            | `src/health.ts`            | Collects health data (pure function)                 |
| Health Server     | `src/health-server.ts`     | HTTP endpoint on port 3002                           |
| Watchdog          | `src/watchdog.ts`          | systemd heartbeat (WATCHDOG=1 every 2s)              |
| Session Cleanup   | `src/session-cleanup.ts`   | Prunes stale session artifacts daily                 |
| DB                | `src/db.ts`                | SQLite schema, migrations, all data access           |

## Container Isolation Model

Each container gets:

- Its own group folder at `/workspace/group` (read-write)
- Claude session files at `/workspace/group/.claude/`
- Access to MCP servers (Gmail, Calendar, docs, etc.)
- Network access (for API calls, web fetches)
- No access to `.env` or other groups' data

**Main agent** additionally gets:

- Project root at `/workspace/project` (read-only, `.env` shadowed with /dev/null)
- SQLite store at `/workspace/project/store` (read-write)
- Global memory at `/workspace/global` (read-write)
- Ability to register new groups via IPC

**Non-main agents** additionally get:

- Global memory at `/workspace/global` (read-only)

## Database

Single SQLite file at `store/messages.db`. Key tables:

| Table               | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `messages`          | All inbound messages from all channels              |
| `chats`             | Known chat/group metadata                           |
| `registered_groups` | Group → folder mapping, trigger config, isMain flag |
| `sessions`          | Group → Claude session ID mapping                   |
| `scheduled_tasks`   | Cron/interval/once tasks with next_run tracking     |
| `task_run_logs`     | Execution history for scheduled tasks               |
| `reactions`         | Emoji reactions on messages                         |
| `rate_limits`       | Anthropic API rate limit snapshots                  |
| `schema_version`    | Migration tracking                                  |

Schema is versioned with idempotent migrations in `src/db.ts`. Migrations run automatically on startup.

## Credential Flow

Containers never see real API keys. The credential proxy (`localhost:3001`) intercepts outbound Anthropic API requests
and injects the real key:

```
Container agent ──► HTTP request with placeholder token
                          │
                          ▼
                    Credential proxy (port 3001)
                    Injects real ANTHROPIC_API_KEY
                          │
                          ▼
                    api.anthropic.com
```

The `.env` file is explicitly shadowed with `/dev/null` in the container mount, preventing direct reads.

## IPC Mechanism

Containers communicate with the host via JSON files in `data/ipc/{group}/`:

- `messages/` — outbound messages from agent to channel (send_message, send_blocks)
- `tasks/` — task scheduling requests from agent

The host polls these directories and processes files as they appear. This avoids network-based IPC and works within
Docker's filesystem mount model.

## Scheduled Tasks

The task scheduler (`src/task-scheduler.ts`) polls every 60 seconds:

1. Finds tasks where `next_run <= now` and `status = 'active'`
2. Spawns a container with the task's prompt
3. Logs result to `task_run_logs`
4. Computes next run time

Task types: `cron` (recurring), `interval` (every N ms), `once` (fire and delete).

## Directory Layout

```
nanoclaw/
├── src/                    # Host process source (TypeScript)
├── container/
│   ├── Dockerfile          # Agent container image
│   ├── build.sh            # Build script
│   └── agent-runner/
│       └── src/            # Agent-side code (runs inside container)
├── store/
│   └── messages.db         # SQLite database
├── data/
│   ├── sessions/{group}/   # Claude session files
│   └── ipc/{group}/        # IPC message/task files
├── groups/
│   ├── global/             # Shared memory (main writes, others read)
│   ├── main/               # Main group runtime data
│   ├── slack_*/            # Slack channel groups
│   └── whatsapp_*/         # WhatsApp groups
├── docs/                   # Design documentation
├── runbooks/               # Operational runbooks (you are here)
├── scripts/                # Utility scripts (smoke test, cleanup)
└── .env                    # Secrets (never committed, shadowed in containers)
```
