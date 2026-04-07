# Troubleshooting

Symptom-based guide. Find your problem, follow the steps.

## Agent Not Responding to Messages

**Check message loop:**

```bash
curl -s http://127.0.0.1:3002/health | python3 -c "import json,sys; d=json.load(sys.stdin); print('Loop:', d.get('messageLoopRunning')); print('Queue active:', d.get('queueActiveCount')); print('Queue waiting:', d.get('queueWaitingCount'))"
```

**Check channel connectivity:**

```bash
curl -s http://127.0.0.1:3002/health | python3 -c "import json,sys; d=json.load(sys.stdin); [print(c['name'], c['connected']) for c in d.get('channels',[])]"
```

**Check if message is in DB:**

```bash
cd /path/to/nanoclaw
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly:true});
const rows = db.prepare('SELECT id, chat_jid, sender_name, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT 5').all();
rows.forEach(r => console.log(r.timestamp, r.sender_name, r.content?.substring(0, 80)));
"
```

If the message isn't in the DB, the channel isn't receiving it. If it's in the DB but no response, the container may be
failing to spawn.

**Check container spawning:**

```bash
journalctl --user -u nanoclaw -n 100 | grep -i "container\|spawn\|error"
```

## Container Fails to Start

**Is Docker running?**

```bash
docker info >/dev/null 2>&1 && echo "OK" || echo "Docker not running"
```

**Does the image exist?**

```bash
docker images nanoclaw-agent:latest
```

If missing, rebuild: `./container/build.sh`

**Disk space?**

```bash
df -h /var/lib/docker
df -h /path/to/nanoclaw/store
```

**Resource limits?** Check if the host has enough memory for containers (default 2GB each, up to 5 concurrent = 10GB).
Reduce limits if needed:

```bash
# In .env
CONTAINER_MEMORY_LIMIT=1g
CONTAINER_CPU_LIMIT=1
MAX_CONCURRENT_CONTAINERS=3
```

**Docker socket permissions?**

```bash
docker ps >/dev/null 2>&1 && echo "OK" || echo "Permission denied - check docker group membership"
```

## Channel Disconnected

### Slack

Slack uses Socket Mode (persistent WebSocket). If disconnected:

1. Check the bot token in `.env` (`SLACK_BOT_TOKEN`)
2. Check Slack app settings at api.slack.com — is Socket Mode enabled?
3. Restart the service: `systemctl --user restart nanoclaw`

### WhatsApp

WhatsApp auth uses a pairing code linked to a phone number:

1. Check logs for auth errors: `journalctl --user -u nanoclaw | grep -i whatsapp`
2. Re-authenticate: `npm run auth --pairing-code --phone <number>`
3. If persistent, delete auth state and re-pair: remove `data/whatsapp-auth/` and re-authenticate

### Gmail

Gmail uses OAuth with auto-refresh:

1. Check logs: `journalctl --user -u nanoclaw | grep -i gmail`
2. If token expired: remove `~/.gmail-mcp/credentials.json`
3. Re-authenticate:
   `GOOGLE_OAUTH_CREDENTIALS=~/.gmail-mcp/gcp-oauth.keys.json CREDENTIALS_PATH=~/.gmail-mcp/credentials.json npx -y @gongrzhe/server-gmail-autoauth-mcp`

### Telegram

1. Check bot token validity: `curl https://api.telegram.org/bot<TOKEN>/getMe`
2. Check logs: `journalctl --user -u nanoclaw | grep -i telegram`

## Session Errors

### "No conversation found with session ID"

The stale session auto-recovery handles this automatically. The regex in `src/index.ts` detects the error, clears the
session, and the retry loop starts a fresh session. If it keeps recurring:

```bash
# Check which sessions exist
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly:true});
db.prepare('SELECT * FROM sessions').all().forEach(r => console.log(r.group_folder, r.session_id));
"
```

### Session Too Large (>10MB)

The host auto-clears sessions exceeding 10MB before resuming. You can also manually clear:

- Send `/clear` in the affected channel
- Or send `/compact` to summarize and reduce size

### Context Window Full

Send `/compact` to trigger auto-compaction, which summarizes the conversation history.

## Scheduled Tasks Not Firing

**Check task status:**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly:true});
db.prepare('SELECT id, group_folder, status, schedule_type, schedule_value, next_run FROM scheduled_tasks ORDER BY next_run').all().forEach(r => console.log(r.status, r.next_run, r.group_folder, r.schedule_value));
"
```

**Common causes:**

- Task status is `paused` — happens when the group folder doesn't exist. Create the folder or fix the mapping.
- `next_run` is in the future — wait for it, or check timezone settings.
- The scheduler polls every 60s — tasks may fire up to 60s late.

**Check recent task runs:**

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly:true});
db.prepare('SELECT * FROM task_run_logs ORDER BY started_at DESC LIMIT 5').all().forEach(r => console.log(r.started_at, r.status, r.duration_ms+'ms', r.error?.substring(0,100)||''));
"
```

## High Memory Usage

**Check Node.js process:**

```bash
ps aux | grep nanoclaw | grep -v grep
```

**Check running containers:**

```bash
docker stats --no-stream
```

**Mitigations:**

1. Reduce `MAX_CONCURRENT_CONTAINERS` (default 5)
2. Reduce `CONTAINER_MEMORY_LIMIT` (default 2g)
3. Run session cleanup manually: `bash scripts/cleanup-sessions.sh`
4. Check for stuck containers: `docker ps` — kill any older than 30 minutes

## Database Issues

### Database Locked

SQLite uses WAL mode. If you get "database is locked":

1. Check for multiple processes accessing the DB: `fuser store/messages.db`
2. Check for stuck containers that might hold a connection
3. Restart the service as a last resort

### Database Corrupt

```bash
# Check integrity
sqlite3 store/messages.db "PRAGMA integrity_check;"

# If corrupt, restore from backup or re-initialize
# (messages will be lost, but channels will re-populate)
cp store/messages.db store/messages.db.corrupt
rm store/messages.db
systemctl --user restart nanoclaw
```

## MCP Server Unreachable

MCP servers are optional and configured via env vars. If one is down, the agent loses that capability but continues
working.

**Check connectivity:**

```bash
# Documentation server
curl -s ${DOCS_MCP_URL:-"not configured"}

# Journal server
curl -s ${JOURNAL_MCP_URL:-"not configured"}
```

**If a server is down:** The agent will get tool errors but won't crash. Fix the server independently.
