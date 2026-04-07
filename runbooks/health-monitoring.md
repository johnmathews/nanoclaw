# Health Monitoring

Three levels of health checking: HTTP endpoint (automated), smoke test (CI/manual), and chat commands (ad-hoc).

## HTTP Health Endpoint

```bash
curl -s http://127.0.0.1:3002/health | python3 -m json.tool
```

Returns HTTP 200 (healthy) or 503 (degraded). Response fields:

| Field                | Healthy                   | Investigate When                                |
| -------------------- | ------------------------- | ----------------------------------------------- |
| `status`             | `"healthy"`               | `"degraded"`                                    |
| `uptime`             | Seconds since start       | Very low (crash-looping)                        |
| `channels`           | All `connected: true`     | Any channel disconnected                        |
| `messageLoopRunning` | `true`                    | `false` — message loop has stopped              |
| `queueActiveCount`   | 0–5                       | Stuck at max for extended time                  |
| `queueWaitingCount`  | 0                         | Growing continuously (containers not finishing) |
| `messageCursorAge`   | Recent timestamp          | >5 min old with no active containers            |
| `activeTasks`        | Number of scheduled tasks | 0 if tasks expected                             |
| `recentTaskFailures` | 0                         | >0 indicates task errors in last 24h            |

### Quick Health Check Script

```bash
STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/health)
if [ "$STATUS" = "200" ]; then echo "OK"; else echo "DEGRADED ($STATUS)"; fi
```

## Smoke Test

More thorough than the health endpoint — also checks the database:

```bash
# Quick: health endpoint + DB staleness check
npx tsx scripts/smoke-test.ts

# Full: injects a test message and waits for a response
npx tsx scripts/smoke-test.ts --full

# Custom port/timeout
npx tsx scripts/smoke-test.ts --port=3002 --timeout=120
```

Exit code 0 = healthy, 1 = unhealthy. Suitable for CI or cron-based alerting.

## Chat Commands

Any user can send these from any connected channel:

| Command   | What It Shows                                                       |
| --------- | ------------------------------------------------------------------- |
| `/status` | Uptime, channel connectivity, queue depth, cursor age, task summary |
| `/usage`  | API rate limit utilization with progress bars and reset times       |
| `/model`  | Current model for this group                                        |

Note: Slack intercepts `/` as native slash commands, so use `\status` in Slack.

## What Each Health Signal Means

### Channel Disconnected

A channel showing `connected: false` means messages from that platform won't be received. Common causes:

- **WhatsApp**: Auth token expired. Requires re-pairing (`npm run auth --pairing-code --phone <number>`)
- **Slack**: Socket Mode connection dropped. Usually reconnects automatically; restart if persistent
- **Telegram**: Webhook or polling failure. Check bot token validity
- **Gmail**: OAuth token expired. Re-authenticate by removing `~/.gmail-mcp/credentials.json`

### Queue Growing

If `queueWaitingCount` keeps rising while `queueActiveCount` is at max (5):

1. Check if containers are stuck: `docker ps` — look for containers running longer than 30 minutes
2. Check container logs: `docker logs <container-name>`
3. Check disk space: containers need room for ephemeral storage
4. Consider increasing `MAX_CONCURRENT_CONTAINERS` if load is legitimately high

### Message Cursor Stale

If `messageCursorAge` is >5 minutes and no containers are active, the message loop may have stalled. Check:

1. `systemctl --user status nanoclaw` — is the process running?
2. `journalctl --user -u nanoclaw -n 50` — any errors?
3. If the watchdog is working, systemd should have already restarted it

### Recent Task Failures

If `recentTaskFailures > 0`, check the task run logs:

```bash
# From the project directory
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly:true});
const rows = db.prepare('SELECT * FROM task_run_logs WHERE status = ? ORDER BY started_at DESC LIMIT 10').all('error');
rows.forEach(r => console.log(r.started_at, r.task_id, r.error?.substring(0, 200)));
"
```

## Alerting Recommendations

| Check                | Frequency    | Alert When                         |
| -------------------- | ------------ | ---------------------------------- |
| Health endpoint      | Every 60s    | HTTP 503 for >3 consecutive checks |
| Smoke test (quick)   | Every 5 min  | Exit code 1                        |
| Smoke test (full)    | Every 30 min | Exit code 1                        |
| Channel connectivity | Every 60s    | Any channel disconnected >5 min    |
| Disk space           | Every 15 min | <1GB free on store/ partition      |
