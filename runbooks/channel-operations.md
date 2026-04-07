# Channel Operations

Channels are the messaging platform integrations. Each channel self-registers at startup and handles its own connection
lifecycle.

## Registered Groups

Every chat/group that NanoClaw responds to is a registered group. List them:

```bash
cd /path/to/nanoclaw
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db', {readonly:true});
db.prepare('SELECT name, folder, is_main, requires_trigger, trigger_pattern FROM registered_groups ORDER BY added_at').all().forEach(r => {
  const flags = [r.is_main ? 'main' : '', r.requires_trigger ? 'trigger-required' : ''].filter(Boolean).join(', ');
  console.log(r.folder.padEnd(25), r.name.padEnd(20), flags || 'responds to all');
});
"
```

## Group Configuration

### Trigger Pattern

Each group has a `trigger_pattern` (default: `@agent`). When `requires_trigger = true`, the agent only responds to
messages starting with the trigger word. When `false`, it responds to everything.

### Per-Group Model

Override the default model by placing `config.json` in the group folder:

```bash
echo '{"model": "sonnet"}' > groups/slack_docs/config.json
```

Supported aliases: `opus` → `claude-opus-4-6`, `sonnet` → `claude-sonnet-4-6`, `haiku` → `claude-haiku-4-5-20251001`.
Full model IDs also accepted. Read on every container spawn — no restart needed.

### Per-Group Instructions

Each group has a `CLAUDE.md` file in its folder (`groups/{folder}/CLAUDE.md`) that provides the agent with group-specific
instructions and memory. Edit this file to change the agent's behaviour for that group.

### Global Shared Memory

`groups/global/CLAUDE.md` is readable by all agents and writable by the main agent. Use it for instructions that should
apply everywhere (user preferences, infrastructure context).

## Channel-Specific Notes

### Slack

- **Connection**: Socket Mode (persistent WebSocket, no public URL needed)
- **Auth**: Bot token (`SLACK_BOT_TOKEN` in `.env`) + App token for Socket Mode
- **Message limit**: 4000 characters per message (auto-split)
- **Thread support**: Full — agents see thread history and reply in-thread
- **Typing indicator**: `:eyes:` reaction on the triggering message
- **Block Kit**: Supports interactive messages (checkboxes, buttons) via `send_blocks`
- **Slash commands**: Use `\` prefix (Slack intercepts `/`)

### WhatsApp

- **Connection**: Baileys library (unofficial WhatsApp Web API)
- **Auth**: Pairing code linked to a phone number
- **Own number**: Runs on its own WhatsApp Business account (`ASSISTANT_HAS_OWN_NUMBER=true`)
- **Typing indicator**: Native composing presence
- **Image handling**: Downloads, resizes, base64-encodes on host before container spawn
- **Voice notes**: Transcribed via OpenAI Whisper API
- **Re-auth**: `npm run auth --pairing-code --phone <number>`

### Gmail

- **Connection**: OAuth2 with auto-refresh
- **Auth**: GCP OAuth keys at `~/.gmail-mcp/gcp-oauth.keys.json`, credentials at `~/.gmail-mcp/credentials.json`
- **Modes**: Tool-only (agent reads/sends when triggered from other channels) or full channel (emails trigger the agent)
- **Re-auth**: Remove `~/.gmail-mcp/credentials.json` and re-run the MCP server auth flow

### Telegram

- **Connection**: Bot API (polling or webhook)
- **Auth**: Bot token from @BotFather
- **Typing indicator**: Native `sendChatAction('typing')`

## Adding a New Group

Groups are registered via the main agent's `register_group` MCP tool, or directly in the database. The main agent can be
instructed to register new groups from any channel where it has main access.

Required fields:

- `jid` — platform-specific chat identifier (e.g., `slack:C0AMA1R7EPK`, `31683775990@s.whatsapp.net`)
- `name` — display name
- `folder` — channel-prefixed folder name (e.g., `slack_my-channel`, `whatsapp_family`)
- `trigger` — trigger word

The group folder (`groups/{folder}/`) is created automatically if it doesn't exist.

## Removing a Group

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');
db.prepare('DELETE FROM registered_groups WHERE folder = ?').run('slack_old-channel');
console.log('Deleted');
"
```

Then optionally clean up the group folder: `rm -rf groups/slack_old-channel/`

## Git Identity Per Channel

Different channels use different git committer identities:

| Channel  | Identity                                                       | Configured In                                            |
| -------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Slack    | `nanoclaw-slack-agents <nanoclaw-slack-agents@nanoclaw.local>` | Repo-local `.git/config` (default)                       |
| WhatsApp | `nanoclaw-whatsapp <nanoclaw-whatsapp@nanoclaw.local>`         | `groups/whatsapp_main/CLAUDE.md` (per-commit `-c` flags) |
