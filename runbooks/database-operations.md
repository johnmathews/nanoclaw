# Database Operations

NanoClaw uses a single SQLite database at `store/messages.db`. All state lives here: messages, sessions, tasks, groups,
rate limits.

## Accessing the Database

SQLite CLI isn't always available in containers. Use `better-sqlite3` via Node.js:

```bash
cd /path/to/nanoclaw
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly:true});
// Your query here
"
```

Or if `sqlite3` is available on the host:

```bash
sqlite3 store/messages.db
```

## Useful Queries

### List Registered Groups

```sql
SELECT name, folder, is_main, requires_trigger, trigger_pattern
FROM registered_groups ORDER BY added_at;
```

### Active Sessions

```sql
SELECT group_folder, session_id FROM sessions;
```

### Recent Messages

```sql
SELECT timestamp, sender_name, chat_jid, content
FROM messages ORDER BY timestamp DESC LIMIT 20;
```

### Messages for a Specific Group

```sql
SELECT timestamp, sender_name, content
FROM messages
WHERE chat_jid = 'slack:C0AMA1R7EPK'
ORDER BY timestamp DESC LIMIT 20;
```

### Scheduled Tasks

```sql
SELECT id, group_folder, status, schedule_type, schedule_value, next_run
FROM scheduled_tasks ORDER BY next_run;
```

### Recent Task Failures

```sql
SELECT started_at, task_id, status, duration_ms, error
FROM task_run_logs
WHERE status = 'error'
ORDER BY started_at DESC LIMIT 10;
```

### Task Run History

```sql
SELECT started_at, task_id, status, duration_ms
FROM task_run_logs
ORDER BY started_at DESC LIMIT 20;
```

### Rate Limits

```sql
SELECT rate_limit_type, status, utilization, resets_at, updated_at
FROM rate_limits;
```

### Schema Version

```sql
SELECT version, applied_at FROM schema_version ORDER BY version;
```

## Schema Versioning

Migrations are defined in `src/db.ts` as an array of `{version, description, up()}` objects. On startup,
`runMigrations()` checks the current version and runs pending migrations. Each migration is idempotent (wrapped in
try-catch for "column already exists").

To see the current schema version:

```sql
SELECT MAX(version) as current_version FROM schema_version;
```

To see all migrations that have run:

```sql
SELECT * FROM schema_version ORDER BY version;
```

## Session Management

### Session Files

Claude session histories are stored as `.jsonl` files at:

```
data/sessions/{group}/.claude/projects/-workspace-group/
```

### Session Cleanup

Automatic cleanup runs on startup and every 24 hours (`scripts/cleanup-sessions.sh`). It:

- Finds session artifacts older than 7 days
- Preserves active sessions (referenced in the `sessions` DB table)
- Removes orphaned `.jsonl` files, debug logs, todos, telemetry

Manual cleanup:

```bash
bash scripts/cleanup-sessions.sh
```

### Clearing a Specific Session

From a channel, send `/clear` to delete the session and start fresh.

Or manually:

```bash
# Find the session
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');
const row = db.prepare('SELECT * FROM sessions WHERE group_folder = ?').get('slack_git-maintenance');
console.log(row);
// Delete it
db.prepare('DELETE FROM sessions WHERE group_folder = ?').run('slack_git-maintenance');
"
```

### Session Size Limit

The host checks session file size before resuming. If a session exceeds 10MB, it's automatically cleared to prevent
prompt-too-long deadlocks. This is logged as a warning.

## Backups

SQLite is a single file. Back it up with:

```bash
# Safe copy (while DB is in use)
sqlite3 store/messages.db ".backup store/messages.db.bak"

# Or with the SQLite online backup API
cp store/messages.db store/messages.db.bak  # OK if WAL is also copied
```

**What to back up:**

- `store/messages.db` — all state
- `groups/` — per-group config and memory
- `.env` — credentials (store securely, separately)
- `data/sessions/` — conversation history (large, optional)

**What you can lose:**

- `data/ipc/` — transient, regenerated
- `data/sessions/` — agents start fresh sessions (minor inconvenience)
- Container image — rebuilt from Dockerfile

## Deleting Old Data

### Purge Old Messages

```sql
DELETE FROM messages WHERE timestamp < datetime('now', '-30 days');
```

### Purge Old Task Logs

```sql
DELETE FROM task_run_logs WHERE started_at < datetime('now', '-30 days');
```

### Vacuum After Purge

```sql
VACUUM;
```

This reclaims disk space after large deletions.
