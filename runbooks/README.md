# NanoClaw SRE Runbooks

NanoClaw is a personal AI assistant that runs Claude agents in isolated Docker containers, routing messages from chat
platforms (Slack, WhatsApp, Telegram, Gmail) to containerized agents and back. It's a single Node.js process on a Linux
host managing the full lifecycle: message ingestion, container orchestration, session management, and scheduled tasks.

## Start Here

If you're new to this system, read these in order:

1. [Architecture Overview](architecture-overview.md) — how the pieces fit together
2. [Service Management](service-management.md) — starting, stopping, logs
3. [Health Monitoring](health-monitoring.md) — checking if things are working

## All Runbooks

| Runbook                                           | Use When                                         |
| ------------------------------------------------- | ------------------------------------------------ |
| [Architecture Overview](architecture-overview.md) | You need to understand how NanoClaw works        |
| [Service Management](service-management.md)       | Starting, stopping, restarting the service       |
| [Health Monitoring](health-monitoring.md)         | Checking if the system is healthy                |
| [Troubleshooting](troubleshooting.md)             | Something is broken and you need to fix it       |
| [Container Management](container-management.md)   | Docker container issues, builds, resource limits |
| [Database Operations](database-operations.md)     | Querying state, backups, session cleanup         |
| [Channel Operations](channel-operations.md)       | Managing Slack, WhatsApp, Gmail, Telegram        |
| [Upstream Sync](upstream-sync.md)                 | Keeping the fork up to date with upstream        |

## Key Paths

| Path                | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `src/index.ts`      | Main orchestrator                                 |
| `store/messages.db` | SQLite database (all state)                       |
| `groups/{name}/`    | Per-group config and memory (runtime, gitignored) |
| `groups/global/`    | Shared memory across all groups                   |
| `data/sessions/`    | Claude session files per group                    |
| `data/ipc/`         | Inter-process communication files                 |
| `container/`        | Dockerfile, agent-runner source, build scripts    |
| `.env`              | Secrets (API keys, tokens — never committed)      |

## Key Ports

| Port | Service                                                     |
| ---- | ----------------------------------------------------------- |
| 3001 | Credential proxy (injects API keys into container requests) |
| 3002 | Health endpoint (`GET /health`)                             |
