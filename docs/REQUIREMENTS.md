# NanoClaw Requirements

Original requirements and design decisions from the project creator. Philosophy first; current architecture decisions
inline at the bottom. For implementation details see [SPEC.md](SPEC.md) and the [runbooks](../runbooks/).

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity — 4-5
different processes running different gateways, endless configuration files, endless integrations. It's a security
nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them
from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole
codebase. When you run it you're kind of just yoloing it.

NanoClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files.
No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual
OS-isolated containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access
is safe because commands run inside the container, not on your host. Credentials are injected at the network boundary
by a local proxy so the container never holds long-lived API keys — see [SECURITY.md](SECURITY.md).

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use WhatsApp, Slack, and Gmail,
so it supports those. The codebase will only grow integrations the operator actually wants — not every possible one.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is
safe and practical. Very minimal things (trigger word, model defaults) are in config. Everything else — just change
the code.

### AI-Native Development

I don't need an installation wizard — Claude Code guides the setup. I don't need a monitoring dashboard — I ask
Claude Code what's happening. I don't need elaborate logging UIs — I ask Claude to read the logs. I don't need
debugging tools — I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or
self-debugging because Claude is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like
`/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean
code that does exactly what they need — not a bloated system trying to support everyone's use case simultaneously.

Channel skills live on **separate remotes** (`whatsapp`, `slack`, `gmail`) rather than as branches of the main repo.
See [runbooks/upstream-sync.md](../runbooks/upstream-sync.md).

---

## Vision

A personal Claude assistant accessible via multiple channels, with minimal custom code.

**Core components:**

- **Claude Agent SDK** as the core agent
- **Containers** for isolated agent execution
- **Credential proxy** so the container never sees long-lived API keys or OAuth tokens
- **Multi-channel messaging** (WhatsApp, Slack, Telegram, Discord, Gmail) — channels are skills that self-register at startup
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run Claude and can message back
- **Health monitoring** — HTTP `/health` endpoint, systemd watchdog, `/status` chat command
- **Web access** via WebSearch and WebFetch
- **Browser automation** via agent-browser
- **MCP integrations** for Gmail, Google Calendar, journal, docs, parallel-search

**Implementation approach:**

- Use existing tools (Claude Agent SDK, MCP servers)
- Minimal glue code
- File-based systems where possible (CLAUDE.md for memory, folders for groups)

---

## Architecture Decisions

### Message Routing

- A router listens to each channel and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@<ASSISTANT_NAME>` prefix (case-insensitive), regex-escaped
- Groups can be flagged `requiresTrigger=false` — all senders trusted as the owner, no trigger needed (used for direct conversations)
- Unregistered groups are ignored completely

### Memory System

- **Per-group memory**: each group has a folder with its own `CLAUDE.md`
- **Global memory**: root `CLAUDE.md` is read by all groups, but only writable from "main" (self-chat)
- Agent runs in the group's folder, automatically inherits both CLAUDE.md files

### Session Management

- Each group maintains a conversation session via the Claude Agent SDK
- Sessions auto-compact when context gets too long (threshold `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, default 165k)
- Host-side safety net: sessions exceeding 10MB are auto-cleared on resume to prevent deadlocks
- Users can send `/compact` or `/clear` to manage history

### Container Isolation

- All agents run inside containers
- Each agent invocation spawns a container with mounted directories
- Containers see only what's mounted; bash is safe because it runs in the container
- Browser automation via agent-browser (Chromium in-container)
- Default Docker on Linux; Apple Container available via `/convert-to-apple-container` skill on macOS

### Credential Handling

- Two auth modes detected at startup: `ANTHROPIC_API_KEY` (billed API key) or `CLAUDE_CODE_OAUTH_TOKEN` (Max subscription)
- A local HTTP proxy on `CREDENTIAL_PROXY_PORT` (default 3001) injects credentials at the network boundary
- Containers ship with a placeholder credential; the proxy swaps it for the real one transparently
- See [SECURITY.md §5](SECURITY.md#5-credential-isolation-credential-proxy) for the exchange flow

### Scheduled Tasks

- Users can ask Claude to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks can optionally send messages to their group, or complete silently
- Task runs are logged with duration and result
- Schedule types: cron, interval (ms), one-time (ISO timestamp)
- From main: schedule for any group, view/manage all
- From other groups: own tasks only

### Group Management

- New groups are added explicitly via the main channel
- Registered in SQLite (via `register_group` IPC command)
- Each group gets a folder under `groups/`
- Per-group `config.json` can override the default model (`opus`/`sonnet`/`haiku` aliases or full IDs)
- Per-group `skipImageMultimodal` opts out of sending images as multimodal content (still downloads them and leaves text refs)
- Groups can have additional directories mounted via `containerConfig.additionalMounts` — validated against the external allowlist

### Health & Resilience

- HTTP `GET /health` on port 3002 returns JSON (200 healthy, 503 degraded)
- Systemd watchdog: `WATCHDOG=1` every 2s; restart after 15 missed (30s)
- `/status` chat command surfaces the same data via any channel
- `npx tsx scripts/smoke-test.ts` for CI-style health checks

### Sender Allowlist

- Optional per-channel sender allowlist (`~/.config/nanoclaw/sender-allowlist.json`) — when present, messages from
  senders outside the allowlist are dropped. Defense against compromised channel keys.

---

## Integration Points

### Channels

| Channel  | Auth                          | Status                              |
| -------- | ----------------------------- | ----------------------------------- |
| Slack    | Socket Mode (`SLACK_BOT_TOKEN`) | Core, thread support, image vision |
| Gmail    | OAuth via `@gongrzhe/server-gmail-autoauth-mcp` | Core; both as channel and MCP |
| WhatsApp | Pairing code (baileys)        | **Separate fork** (`whatsapp` remote); install via `/add-whatsapp` |
| Telegram | Bot token                     | Skill (`/add-telegram`); optional agent-swarm mode |
| Discord  | Bot                           | Skill (`/add-discord`)              |

WhatsApp was extracted to its own remote in 2026-04 because it was the most fragile channel and pulled outage scope
across the rest of the service. Re-pairing is `npm run auth --pairing-code --phone <number>`.

### MCP Servers (always on)

- **Gmail** — read/send email via Gmail API
- **Google Calendar** — read/write events
- **nanoclaw** — in-container; provides scheduling tools (`schedule_task`, `list_tasks`, `send_message`, etc.)

### MCP Servers (conditional, via env var)

- `DOCS_MCP_URL` — documentation server (search, query, get)
- `JOURNAL_MCP_URL` + `JOURNAL_API_TOKEN` — journal entries (OCR, semantic search, mood/topic analytics)
- `PARALLEL_API_KEY` — Parallel AI search and task servers

### Web Access

- Built-in WebSearch and WebFetch (Claude Agent SDK)

### Browser Automation

- `agent-browser` CLI with Chromium in container
- Snapshot-based element references (@e1, @e2, ...)
- Screenshots, PDFs, video recording
- Auth state persistence per group

---

## Setup & Customization

### Philosophy

- Minimal configuration files
- Setup and customization done via Claude Code skills (slash commands)
- Users clone the repo and run skills to configure
- Each user gets a custom setup matching their exact needs

### Skills

Skills are markdown files under `.claude/skills/<name>/SKILL.md` that Claude Code reads and executes. The full
current set is in [CLAUDE.md](../CLAUDE.md#skills). Notable categories:

- **Setup & ops** — `/setup`, `/debug`, `/update-nanoclaw`, `/qodo-pr-resolver`, `/get-qodo-rules`
- **Channels** — `/add-whatsapp`, `/add-slack`, `/add-telegram`, `/add-discord`, `/add-gmail`, `/add-telegram-swarm`
- **Capabilities** — `/add-image-vision`, `/add-voice-transcription`, `/add-pdf-reader`, `/add-reactions`, `/add-ollama-tool`, `/add-parallel`, `/use-local-whisper`, `/claw`, `/add-compact`
- **Runtime** — `/convert-to-apple-container`

### RFS (Request for Skills)

Skills we'd love contributors to build:

- `/add-signal` — Add Signal as a channel
- `/add-sms` — Add SMS via Twilio or similar

### Deployment

- Runs on macOS via launchd or Linux via systemd
- Single Node.js process handles everything
- Systemd unit lives at `~/.config/systemd/user/nanoclaw.service` (created by `/setup`); launchd plist at `~/Library/LaunchAgents/com.nanoclaw.plist`

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@agent` (case-insensitive)
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat in WhatsApp; Slack `#nanoclaw` direct-conversation
- **Auth mode**: OAuth via Max subscription (no API key)

---

## Project Name

**NanoClaw** — A reference to Clawdbot (now OpenClaw).
