# Slack session consolidation, task externalization, and job-search split

Date: 2026-05-26. Tags: decision, fix, ops.

A single long session worked through three intertwined problems on this install,
ending with a clean, durable Slack setup and an enforced convention for scheduled
tasks. Code changes upstream are minimal (one instructions file); the rest is
installation-state cleanup. Documented here so future sessions don't repeat the
diagnostic work.

## Problem 1 — Stranded recurring tasks

**Symptom:** `@main show me your scheduled tasks` in `#main-group` returned
"No scheduled tasks found." But host-sweep was clearly firing the morning report
and documentation-summary every day. Where were they?

**Root cause:** `session_mode='shared'` on the main wiring was silently
overridden by Slack's threading. Every top-level @-mention created a new
session (Slack sets `thread_id = message_ts` for channel-root messages, so the
resolver matches no existing session and creates one). 28 sessions had
accumulated for `main` alone. Live task rows were stranded in the very first
session (`sess-1779373704233-eu40dq`, created 2026-05-21 with `thread_id=NULL`);
every newer session's `inbound.db` was empty of tasks. `list_tasks` only
queries the calling session's own DB (`scheduling.ts:117`), so it correctly
reported zero — from the wrong session.

The CLAUDE.md actually documents this — *"threaded adapters in group chats
force per-thread regardless of this setting"* — but the implication
("recurring tasks are unreachable from new threads") wasn't followed through.

**Fix:** Switched all 9 (remaining, after dropping `#github-events`) Slack
wirings to `session_mode='agent-shared'` so the resolver ignores `thread_id`
and routes every channel message to one canonical session per agent group.
Before flipping the wiring, marked the 62 non-winner sessions as
`status='closed'` so `findSessionByAgentGroup` (which picks
`ORDER BY created_at DESC LIMIT 1`) would lock onto the right session — the
oldest one for task-holding groups (`main`, `slack_nanoclaw-introspection`,
`slack_the-managers-guide`), latest for the rest. Without this ordering, the
resolver would have picked the most recent (empty) session and tasks would
stay stranded.

Also during this pass: deleted the `#github-events` wiring entirely (it
receives GitHub webhook notifications only — no agent engagement wanted) and
renamed `slack_git-maintenance` → `slack_nanoclaw-introspection` since after
the unwiring it was only attached to `#nanoclaw-introspection`.

## Problem 2 — Task instructions baked into DB rows

**Symptom:** Asked to read what one of the recurring tasks actually *does*,
had to query `messages_in.content` JSON. No file to read or edit.

**Decision:** Externalize every task's instructions into
`groups/<folder>/tasks/<slug>.md`. The task row's `prompt` becomes a one-line
pointer: *"Read /workspace/agent/tasks/<slug>.md and follow the instructions
there exactly. The file is the single source of truth — if anything in this
prompt seems to conflict with the file, the file wins."*

The runtime mechanism is just text — when the cron fires, the formatter wraps
the prompt in `<task>…</task>`, Claude sees "Read X.md", calls its `Read`
tool, and gets the file at runtime. Nothing in the schema or code enforces
the file-vs-inline split; it's a contract documented in
`scheduling.instructions.md` (which composes into every agent's CLAUDE.md on
spawn) and a convention applied to all existing tasks via a migration script.

**Migrated 4 live tasks** (the only ones across the install):
- `main` / morning-report (daily 07:28)
- `main` / documentation-summary (daily 09:03 — currently paused)
- `slack_nanoclaw-introspection` / git-maintenance (Mon+Thu 02:03)
- `slack_the-managers-guide` / newsletter-extraction (Wed 02:07)

Each had v1-isms in its prompt — `/workspace/group/...` (the v1 group-folder
mount path) instead of v2's `/workspace/agent/...`. Fixed those as part of
the externalization. The agent had been compensating (LLM tolerance for
broken paths) but the brittleness was real.

The `_extraction-config.md` and `_extraction-tracker.md` files for the
managers-guide newsletter also moved into `tasks/` — config merged into
`tasks/newsletter-extraction.md` (same one-file-per-task pattern as
morning-report), tracker kept separate as
`tasks/newsletter-extraction-tracker.md` because it's mutable state.

## Problem 3 — Job-search split for two people

John asked to add a parallel `slack_job-search-ritsya` group for his wife. The
existing `slack_job-search` group was renamed to `slack_job-search-john` for
symmetry. The setup script (`scripts/setup-ritsya-job-search.ts`) creates the
new agent group + container_configs + messaging_groups + wiring rows in one
transaction, scaffolds the directory with blank criteria templates, and adds
the new path to main's `additional_mounts` so the main agent can read both
people's job-search state cross-channel.

**Gotcha that surfaced:** The setup script initially set
`unknown_sender_policy='strict'` (the schema default). All of John's other
Slack messaging_groups have `'public'` — strict requires the sender to be a
member in `agent_group_members`, which is empty on this install. Result:
every message in `#job-search-ritsya` was silently dropped with
`accessReason='not_member'` until I noticed the `MESSAGE DROPPED — unknown
sender (strict policy)` log line. Patched the script + saved a memory.

The two job-search agents are now structurally identical:

```
groups/slack_job-search-{john,ritsya}/
├── CLAUDE.local.md          # role + "Handling CV uploads" rule
├── README.md                # human-readable overview
├── criteria/                # 01-role.md … 07-job-boards.md preferences
├── cv/                      # CV PDFs the agent reads when matching
└── history/                 # past reports, screenshots
```

CV uploads via Slack land in the session inbox (`/workspace/inbox/<msgid>/`)
by default — not in `cv/`. Added a rule to both groups' `CLAUDE.local.md`
instructing the agent to copy CV-shaped PDFs from inbox → `cv/` with a
descriptive filename before doing anything else.

## Code changes

Only one upstream-relevant code change:

- `container/agent-runner/src/mcp-tools/scheduling.instructions.md` — documents
  the `tasks/<slug>.md` externalization convention. Affects every agent on
  every install via the CLAUDE.md composer.

Three one-off scripts (specific to this install but committed as
documentation of what was done):

- `scripts/close-non-winner-sessions.ts` — picked winner sessions per
  agent group, marked the rest `status='closed'`. Dry-run by default.
- `scripts/externalize-task-prompts.ts` — extracted the 4 task prompts to
  `tasks/<slug>.md`, fixed v1 paths, rewrote DB rows. Dry-run by default.
- `scripts/setup-ritsya-job-search.ts` — Phase 1 (rename John) + Phase 2
  (create Ritsya) in one transactional run. Dry-run by default.

## Memories saved

Three new memories so future sessions don't re-discover these:

- `project_slack_per_thread_sessions.md` — the Slack threading vs scheduled
  tasks interaction, and the agent-shared fix.
- `feedback_task_prompts_external.md` — the tasks/<slug>.md convention as a
  permanent invariant.
- `feedback_messaging_group_policy.md` — always set
  `unknown_sender_policy='public'` when inserting messaging_groups.

`reference_operational.md` was 36 days stale (still mentioning the v1 DB
path, old folder names, obsolete `groups/global/`); rewrote it.

## Tests

No new tests. The changes are convention/documentation/installation-state;
the testable logic (`fixV1Paths`, winner picking) is trivial regex/SQL. All
existing tests still pass (host + container) — the host service was never
stopped during the migration, only individual containers (which respawn on
demand).

## Open follow-ups

- `slack_job-search-ritsya` has no scheduled task yet — needs Ritsya's
  criteria + at least one CV before scheduling makes sense.
- `documentation-summary` task in `main` is paused (`status='paused'`); not
  changed by this work. Resume if/when wanted.
- `groups/main/m3/` is a directory of unknown purpose, not touched. Worth
  investigating in a future session.
- Membership / role gates are unused on this install — every messaging_group
  relies on `unknown_sender_policy='public'`. Either fully retire the strict
  model or actually wire it through. Current half-state is a footgun (cf.
  the Ritsya outage).
