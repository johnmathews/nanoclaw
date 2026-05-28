# NanoClaw — Central DB Schema

Complete reference for `data/v2.db`, the host-owned admin-plane database. Start with [db.md](db.md) for the three-DB overview, the map, and the cross-mount rules.

Access layer: `src/db/`. Authoritative schema reference: `src/db/schema.ts` (comments only — actual creation runs via migrations in `src/db/migrations/`).

---

## 1. Tables

### 1.1 `agent_groups`

Agent workspaces. Each maps 1:1 to a `groups/<folder>/` directory containing `CLAUDE.md` and skills. Container config lives in `container_configs` (see §1.x below); a `container.json` file is materialized at spawn time for the container runner to read.

```sql
CREATE TABLE agent_groups (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL UNIQUE,
  agent_provider   TEXT,
  created_at       TEXT NOT NULL
);
```

- **Readers:** `src/session-manager.ts`, `src/delivery.ts`, `src/router.ts`
- **Writers:** `src/db/agent-groups.ts`

### 1.2 `messaging_groups`

One row per platform chat (one WhatsApp group, one Slack channel, one 1:1 DM, etc.).

```sql
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  name                  TEXT,
  is_group              INTEGER DEFAULT 0,
  unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
  reply_mode            TEXT NOT NULL DEFAULT 'thread',
  denied_at             TEXT,
  created_at            TEXT NOT NULL,
  UNIQUE(channel_type, platform_id)
);
```

- `unknown_sender_policy`: `strict` (drop), `request_approval` (ask admin), `public` (allow). The migration-default is `'strict'`, but every caller passes the value explicitly — for new rows, prefer `'public'` unless you specifically want unknown-sender gating; `'strict'` silently drops every message from a sender not on the explicit member list and is rarely what you want.
- `reply_mode`: `thread` (default — reply in the originating thread) or `channel` (reply in the channel root regardless of where the inbound landed). Only meaningful on threaded adapters (Slack); non-threaded adapters already collapse threads in the router. Applied in `src/delivery.ts` by clearing the per-message `thread_id` before calling `adapter.deliver`, so the bridge falls back to `platform_id`.
- `denied_at`: set when the owner denies a channel-registration prompt (see §1.16 `pending_channel_approvals`). Non-NULL means the router drops every future inbound from this channel without re-prompting.
- **Readers:** `src/router.ts`, `src/delivery.ts`, `src/session-manager.ts`
- **Writers:** `src/db/messaging-groups.ts`, channel setup flows

### 1.3 `messaging_group_agents`

Wiring: which agent group handles which messaging group. Many-to-many — the same channel can route to multiple agents (see [isolation-model.md](isolation-model.md)).

```sql
CREATE TABLE messaging_group_agents (
  id                     TEXT PRIMARY KEY,
  messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
  engage_mode            TEXT NOT NULL DEFAULT 'mention',
  engage_pattern         TEXT,
  sender_scope           TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy TEXT NOT NULL DEFAULT 'drop',
  session_mode           TEXT DEFAULT 'shared',
  priority               INTEGER DEFAULT 0,
  created_at             TEXT NOT NULL,
  UNIQUE(messaging_group_id, agent_group_id)
);
```

- `session_mode`: `shared` (one session per channel), `per-thread` (one per thread), `agent-shared` (one session per agent group across all channels — required for Slack since Slack adapters force per-thread routing that would otherwise strand recurring tasks).
- `engage_mode` + `engage_pattern`: when the agent decides to respond. `'pattern'` matches `engage_pattern` (regex; `'.'` means "always"); `'mention'` requires an `@bot` mention; `'mention-sticky'` is mention-to-start, then auto-responds until the conversation goes quiet. Migration 010 replaced the previous `trigger_rules` JSON blob with these orthogonal columns.
- `sender_scope`: `'all'` (anyone may engage the agent) or `'known'` (only registered members; messages from unknown senders are filtered at the router).
- `ignored_message_policy`: `'drop'` (don't store messages the agent won't respond to) or `'accumulate'` (write them to the session DB as context for future engagements).
- **Side effect:** creating a wiring must also populate `agent_destinations` — don't mutate one without the other (see §1.10).

### 1.4 `users`

Platform user identities. ID is namespaced: `tg:123456`, `discord:abc`, `phone:+1555...`, `email:a@x.com`. One human may own several rows — no cross-channel linking yet.

```sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT,
  created_at   TEXT NOT NULL
);
```

- **Writers/readers:** `src/db/users.ts`; channel auth flows

### 1.5 `user_roles`

Permissions. **Privilege is user-level, never agent-group-level.**

```sql
CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id),
  role           TEXT NOT NULL,
  agent_group_id TEXT REFERENCES agent_groups(id),
  granted_by     TEXT REFERENCES users(id),
  granted_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, role, agent_group_id)
);
CREATE INDEX idx_user_roles_scope ON user_roles(agent_group_id, role);
```

Invariants:
- `role = 'owner'` → must be global (`agent_group_id IS NULL`). Enforced in `grantRole()`.
- `role = 'admin'` → global (NULL) or scoped to one agent group.
- Admin @ A implies membership in A — no `agent_group_members` row required.

Access layer: `src/db/user-roles.ts`, `src/access.ts`.

### 1.6 `agent_group_members`

Explicit membership for non-privileged users. Owner and admins don't need rows here — they're implicit members.

```sql
CREATE TABLE agent_group_members (
  user_id        TEXT NOT NULL REFERENCES users(id),
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  added_by       TEXT REFERENCES users(id),
  added_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_group_id)
);
```

### 1.7 `user_dms`

Cache of DM channel discovery. Lets the host send a cold DM (approval card, pairing code) without hitting the platform's `openConversation` API every time.

```sql
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type)
);
```

Populated lazily by `ensureUserDm()` in `src/user-dm.ts`.

### 1.8 `sessions`

Session registry. One row per (agent group, messaging group, thread) tuple subject to `session_mode`. Stores lifecycle metadata only — no messages.

```sql
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
  messaging_group_id TEXT REFERENCES messaging_groups(id),
  thread_id          TEXT,
  agent_provider     TEXT,
  status             TEXT DEFAULT 'active',
  container_status   TEXT DEFAULT 'stopped',
  last_active        TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
```

- **Resolved by:** `resolveSession()` in `src/session-manager.ts`.
- Creating a session also provisions the session folder and both session DBs via `initSessionFolder()` — see [db-session.md](db-session.md).

### 1.9 `pending_questions`

The `ask_user_question` MCP tool parks an interactive question here, and the container matches incoming `system` messages back to it by `questionId`.

```sql
CREATE TABLE pending_questions (
  question_id    TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  message_out_id TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  title          TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
```

### 1.10 `agent_destinations`

Permission ACL *and* name-resolution map for outbound sending. An agent asking to `send_message(to="dev-channel")` must have a row here with `local_name = 'dev-channel'`, or the send is rejected as `unknown destination`.

```sql
CREATE TABLE agent_destinations (
  agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
  local_name     TEXT NOT NULL,
  target_type    TEXT NOT NULL,   -- 'channel' | 'agent'
  target_id      TEXT NOT NULL,   -- messaging_group_id | agent_group_id
  created_at     TEXT NOT NULL,
  PRIMARY KEY (agent_group_id, local_name)
);
CREATE INDEX idx_agent_dest_target ON agent_destinations(target_type, target_id);
```

**Projection invariant (load-bearing).** The central table is the source of truth, but each running container reads from a projection in its own `inbound.db` (see [db-session.md §2.3](db-session.md#23-destinations)). Any code that mutates `agent_destinations` while a container is running must also call `writeDestinations()` (`src/session-manager.ts`) or the container will reject sends with stale data. Known call sites: `createMessagingGroupAgent()` in `src/db/messaging-groups.ts`, the `create_agent` system action in `src/delivery.ts`.

Access layer: `src/db/agent-destinations.ts`.

### 1.11 `pending_approvals`

Two workflows share this table:

- **Session-bound MCP approvals** — `install_packages`, `add_mcp_server`. `session_id` is set.
- **OneCLI credential approvals** — `session_id` may be NULL; `agent_group_id` + `channel_type` + `platform_id` route the admin card.

```sql
CREATE TABLE pending_approvals (
  approval_id         TEXT PRIMARY KEY,
  session_id          TEXT REFERENCES sessions(id),
  request_id          TEXT NOT NULL,
  action              TEXT NOT NULL,
  payload             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  agent_group_id      TEXT REFERENCES agent_groups(id),
  channel_type        TEXT,
  platform_id         TEXT,
  platform_message_id TEXT,
  expires_at          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_pending_approvals_action_status ON pending_approvals(action, status);
```

- `status`: `pending` | `approved` | `rejected` | `expired`.
- `platform_message_id` lets the host edit the admin card in place after a decision.
- Access layer: `src/db/sessions.ts`; sweep + delivery: `src/onecli-approvals.ts`.

### 1.12 `unregistered_senders`

Audit trail: every time a message gets dropped (unknown sender, strict policy), we increment a counter here so admins can see who's been trying to knock.

```sql
CREATE TABLE unregistered_senders (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL,
  user_id            TEXT,
  sender_name        TEXT,
  reason             TEXT NOT NULL,
  messaging_group_id TEXT,
  agent_group_id     TEXT,
  message_count      INTEGER NOT NULL DEFAULT 1,
  first_seen         TEXT NOT NULL,
  last_seen          TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id)
);
CREATE INDEX idx_unregistered_senders_last_seen ON unregistered_senders(last_seen);
```

Writer: `recordDroppedMessage()` in `src/db/dropped-messages.ts`. On conflict, bumps `message_count` + `last_seen`.

### 1.13 Chat SDK bridge tables

State backing the `SqliteStateAdapter` used by the Chat SDK bridge (see [api-details.md](api-details.md)). NanoClaw code rarely touches these directly — they're owned by `src/state-sqlite.ts`.

```sql
CREATE TABLE chat_sdk_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER                    -- unix ts, nullable
);

CREATE TABLE chat_sdk_subscriptions (
  thread_id     TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_sdk_locks (
  thread_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE chat_sdk_lists (
  key        TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  value      TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (key, idx)
);
```

### 1.14 `schema_version`

Migration ledger, written by the migration runner (§2).

```sql
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  applied TEXT NOT NULL
);
```

### 1.15 `container_configs`

Per-agent-group container runtime config. Source of truth for provider, model, packages, MCP servers, mounts, CLI scope, etc. Materialized to `groups/<folder>/container.json` at spawn time.

```sql
CREATE TABLE container_configs (
  agent_group_id         TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
  provider               TEXT,
  model                  TEXT,
  effort                 TEXT,
  image_tag              TEXT,
  assistant_name         TEXT,
  max_messages_per_prompt INTEGER,
  skills                 TEXT NOT NULL DEFAULT '"all"',
  mcp_servers            TEXT NOT NULL DEFAULT '{}',
  packages_apt           TEXT NOT NULL DEFAULT '[]',
  packages_npm           TEXT NOT NULL DEFAULT '[]',
  additional_mounts      TEXT NOT NULL DEFAULT '[]',
  cli_scope              TEXT NOT NULL DEFAULT 'group',   -- disabled | group | global
  updated_at             TEXT NOT NULL
);
```

- **Readers:** `src/container-config.ts`, `src/container-runner.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts`
- **Writers:** `src/db/container-configs.ts`, `src/modules/self-mod/apply.ts`, `src/backfill-container-configs.ts`
- **Default model:** `ensureContainerConfig()` seeds `model = 'claude-opus-4-7'` for new rows via `DEFAULT_MODEL` in `src/db/container-configs.ts`. NULL/empty `model` values are normalized to the default by migration 017. The agent-runner passes whatever's in `model` straight to the Claude Agent SDK — if you intentionally want SDK auto-selection, omit the field rather than leaving it blank in the DB.

### 1.16 `pending_sender_approvals`

Unknown-sender approval flow. When `messaging_groups.unknown_sender_policy = 'request_approval'`, a non-member message triggers an admin card; this row dedups concurrent attempts from the same sender on the same group while the card is in-flight. Cleared on approve or deny.

```sql
CREATE TABLE pending_sender_approvals (
  id                  TEXT PRIMARY KEY,
  messaging_group_id  TEXT NOT NULL REFERENCES messaging_groups(id),
  agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id),
  sender_identity     TEXT NOT NULL,
  sender_name         TEXT,
  original_message    TEXT NOT NULL,
  approver_user_id    TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  UNIQUE(messaging_group_id, sender_identity)
);
```

- `original_message` is a JSON-serialized `InboundEvent` — replayed if the approver clicks Approve.
- `title` + `options_json` are the card render metadata (added in migration 013, mirroring §1.11 `pending_approvals`).
- Introduced by migration 011 (`pending-sender-approvals`).

### 1.17 `pending_channel_approvals`

Unknown-channel registration flow. When a channel with no `messaging_group_agents` wiring receives a mention or DM, the router escalates to the owner. Approve creates a wiring + replays the triggering event; deny stamps `messaging_groups.denied_at` and drops future inbound silently.

```sql
CREATE TABLE pending_channel_approvals (
  messaging_group_id  TEXT PRIMARY KEY REFERENCES messaging_groups(id),
  agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id),
  original_message    TEXT NOT NULL,
  approver_user_id    TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  options_json        TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL
);
```

- PRIMARY KEY on `messaging_group_id` gives free in-flight dedup — a second mention while the card is pending is silently dropped by `INSERT OR IGNORE`, preventing card spam.
- `agent_group_id` is the wiring target picked at request time (currently: earliest `agent_groups` row by `created_at`).
- Introduced by migration 012 (`channel-registration`); `title`/`options_json` added in migration 013.

---

## 2. Migration system

Migrations live in `src/db/migrations/`, one file per migration. Runner: `runMigrations()` in `src/db/migrations/index.ts`. It:

1. Creates `schema_version` if absent.
2. Reads `MAX(version)` — call it `current`.
3. For each migration with `version > current`, executes `up(db)` inside a transaction and appends a `schema_version` row.

| # | File | `name` recorded in `schema_version` | Introduces |
|---|------|--------------------------------------|------------|
| 001 | `001-initial.ts` | `initial` | Core tables: `agent_groups`, `messaging_groups`, `messaging_group_agents`, `users`, `user_roles`, `agent_group_members`, `user_dms`, `sessions`, `pending_questions` |
| 002 | `002-chat-sdk-state.ts` | `chat-sdk-state` | `chat_sdk_kv`, `chat_sdk_subscriptions`, `chat_sdk_locks`, `chat_sdk_lists` |
| 003 | `module-approvals-pending-approvals.ts` | `pending-approvals` | `pending_approvals` (session-bound + OneCLI fields) |
| 004 | `module-agent-to-agent-destinations.ts` | `agent-destinations` | `agent_destinations` + backfill from existing `messaging_group_agents` wirings |
| 007 | `module-approvals-title-options.ts` | `pending-approvals-title-options` | `ALTER TABLE pending_approvals` add `title`, `options_json` (retrofits DBs created between 003 and 007) |
| 008 | `008-dropped-messages.ts` | `dropped-messages` | `unregistered_senders` |
| 009 | `009-drop-pending-credentials.ts` | `drop-pending-credentials` | Drop the defunct `pending_credentials` table |
| 010 | `010-engage-modes.ts` | `engage-modes` | Replace `messaging_group_agents.trigger_rules` + `response_scope` with four orthogonal columns: `engage_mode`, `engage_pattern`, `sender_scope`, `ignored_message_policy`. Per-row backfill from the old JSON. |
| 011 | `011-pending-sender-approvals.ts` | `pending-sender-approvals` | `pending_sender_approvals` (unknown-sender approval flow; in-flight dedup) |
| 012 | `012-channel-registration.ts` | `channel-registration` | `ALTER TABLE messaging_groups ADD COLUMN denied_at`; create `pending_channel_approvals` |
| 013 | `013-approval-render-metadata.ts` | `approval-render-metadata` | `ALTER TABLE pending_sender_approvals / pending_channel_approvals` add `title`, `options_json` (mirrors migration 007 / `module-approvals-title-options`) |
| 014 | `014-container-configs.ts` | `container-configs` | `container_configs` — per-agent-group container runtime config |
| 015 | `015-cli-scope.ts` | `cli-scope` | `ALTER TABLE container_configs ADD COLUMN cli_scope` |
| 016 | `016-reply-mode.ts` | `reply-mode` | `ALTER TABLE messaging_groups ADD COLUMN reply_mode` (`thread`/`channel`; Slack-only effect) |
| 017 | `017-default-model-opus.ts` | `default-model-opus` | Backfills `container_configs.model` from NULL/empty to `claude-opus-4-7` (new default) |

Numbers 005 and 006 are intentionally absent — migrations were renumbered during early development. The three module migrations (`module-*.ts`, originally 003 / 004 / 007) keep their historical `name` values in `schema_version`; the `module-` filename prefix is a code-hygiene rename for install-skill discoverability and is invisible to the migration runner (uniqueness is keyed on `name`, not version number — see `src/db/migrations/index.ts`).

Session DB schemas (`INBOUND_SCHEMA`, `OUTBOUND_SCHEMA`) are **not** versioned here. They're `CREATE TABLE IF NOT EXISTS` so new columns land via the session-DB lazy migration helpers (`migrateDeliveredTable()` etc.) when a session file from an older build is reopened. See [db-session.md](db-session.md).
