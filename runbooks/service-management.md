# Service Management

NanoClaw runs as a systemd user service on Linux. The watchdog integration means systemd will automatically restart the
process if it becomes unresponsive.

## Commands

```bash
# Start / stop / restart
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw

# Check status
systemctl --user status nanoclaw

# View logs (follow mode)
journalctl --user -u nanoclaw -f

# View logs (last 100 lines)
journalctl --user -u nanoclaw -n 100

# View logs since last boot
journalctl --user -u nanoclaw -b
```

## Service File

The service file is at `~/.config/systemd/user/nanoclaw.service`. Key settings:

```ini
[Service]
Type=notify              # Process signals readiness via sd_notify
NotifyAccess=all         # Child processes can also send notifications
WatchdogSec=30s          # Restart if no heartbeat for 30 seconds
Restart=on-failure       # Auto-restart on crash
```

The `Type=notify` and `WatchdogSec` settings are critical — they enable the watchdog described below. If you edit the
service file, reload with:

```bash
systemctl --user daemon-reload
```

## Watchdog

The process sends `WATCHDOG=1` to systemd every 2 seconds from the message loop (`src/watchdog.ts`). If 15 consecutive
heartbeats are missed (30 seconds), systemd considers the process hung and restarts it.

Lifecycle signals:

- `READY=1` — sent after successful startup (channels connected, DB initialized)
- `WATCHDOG=1` — sent every 2s from the message loop
- `STOPPING=1` — sent when graceful shutdown begins

## Startup Sequence

1. Read `.env` file (credentials, config)
2. Initialize SQLite database, run pending migrations
3. Start credential proxy (port 3001)
4. Verify Docker runtime is available
5. Clean up orphaned containers from previous run
6. Connect all channels (Slack, WhatsApp, Telegram, Gmail)
7. Start health HTTP server (port 3002)
8. Start watchdog heartbeat
9. Send `READY=1` to systemd
10. Start message loop (polls every 2s)
11. Start task scheduler (polls every 60s)
12. Start session cleanup (runs on startup + every 24h)

## Graceful Shutdown

When the process receives SIGTERM (from `systemctl stop`):

1. Sends `STOPPING=1` to systemd
2. Stops accepting new messages
3. Waits for active containers to finish (or timeout)
4. Disconnects channels
5. Closes database
6. Exits

## When to Restart

**Restart** when:

- A channel is persistently disconnected (WhatsApp auth expired, Slack socket dropped)
- You've updated `.env` with new credentials
- You've modified source files in `src/` (requires rebuild first: `npm run build`)
- The health endpoint returns 503 and investigation shows no obvious cause

**Don't restart** when:

- A single container fails (the queue retries automatically with backoff)
- A scheduled task fails (logged to `task_run_logs`, won't affect other tasks)
- You've edited a group's `CLAUDE.md` (picked up on next container spawn, no restart needed)
- You've edited `groups/{name}/config.json` (read on every spawn, no restart needed)

## Building After Code Changes

If source files in `src/` have changed:

```bash
npm run build            # Compile TypeScript to dist/
systemctl --user restart nanoclaw
```

If only the agent-runner source (`container/agent-runner/src/`) changed, no rebuild needed — the source is synced into
containers on every spawn.

If the Dockerfile or container dependencies changed:

```bash
./container/build.sh     # Rebuild Docker image
systemctl --user restart nanoclaw
```

## Environment Variables

Key env vars (set in `.env` at project root):

| Variable                    | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY`         | Claude API key (primary auth method)           |
| `ASSISTANT_NAME`            | Trigger word in group chats (default: "agent") |
| `CONTAINER_MEMORY_LIMIT`    | Container RAM limit (default: "2g")            |
| `CONTAINER_CPU_LIMIT`       | Container CPU limit (default: "2")             |
| `MAX_CONCURRENT_CONTAINERS` | Parallel container cap (default: 5)            |
| `HEALTH_PORT`               | Health endpoint port (default: 3002)           |
| `DOCS_MCP_URL`              | Documentation MCP server URL (optional)        |
| `JOURNAL_MCP_URL`           | Journal MCP server URL (optional)              |
| `PARALLEL_API_KEY`          | Parallel AI search/task API key (optional)     |
| `GITHUB_TOKEN`              | GitHub PAT for git operations (optional)       |
