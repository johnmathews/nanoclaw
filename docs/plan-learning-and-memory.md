# Implementation Plan: Learning & Memory Layer

**Status:** in progress — all five features BUILT (committed, not yet live)
**Date:** 2026-06-13
**Companion to:** [proposal-learning-and-memory.md](proposal-learning-and-memory.md)

## Progress

| # | Feature | State | Commit |
|---|---------|-------|--------|
| 3 | Task outcome log | ✅ built | `2fd5f4f` |
| 1 | Budgeted `remember` tool | ✅ built | `7a527c1` |
| 2 | FTS5 `search_history` | ✅ built | `1d0172d` |
| 4 | Self-authored skills | ✅ built | _(this branch)_ |
| 5 | Weekly reflection | ✅ built | _(this branch)_ |

Branch: `feat/learning-memory-task-outcomes`. **Not live** — the service runs compiled `dist/`, so built features are inert until `pnpm run build` + service restart, at which point migrations 020/021 auto-apply (additive, no backfill). Migrations 020 (`task-outcomes`) and 021 (`memory-budgets`) are claimed; 019 was taken by `container-config-env`.

This turns the proposal's five recommendations into a file-level build plan grounded in NanoClaw's actual wiring. Every feature maps onto one of two integration archetypes that already exist:

- **Fire-and-forget system action** — container writes `kind='system'` to `outbound.db` via `writeMessageOut`; the host delivery poll dispatches it through the `registerDeliveryAction` registry (`src/delivery.ts:409`, `handleSystemAction` ~`:421`). Used today by scheduling and self-mod.
- **Request/response round-trip** — container writes a `kind='system'` request, then *polls `inbound.db`* for a `trigger=0` reply the host inserts (`src/cli/delivery-action.ts:41` + container `cli/ncl.ts:91` `pollResponse`). This is the model for any tool that must **return data** to the agent.

**Load-bearing constraint:** the container only ever opens its own session `inbound.db`/`outbound.db`. `data/v2.db` (and any new host index) is host-only, WAL-mode, and unreachable from the container. So any tool that returns data uses the round-trip, never a direct cross-mount read.

---

## Feature 3 — Task outcome log *(build first: smallest, fully independent)*

> **✅ As built (`2fd5f4f`):** matches the plan. Records *every* max-retry failure (not just `kind='task'`) and stores a `kind` column so readers can filter; `getMessageForRetry` was extended to also return `kind` + `series_id`. Recording is best-effort (try/catch) so it can never abort the stale-reset path. Files: `src/db/migrations/020-task-outcomes.ts`, `src/db/task-outcomes.ts` (+ test), `src/host-sweep.ts`, `scheduling.instructions.md`.

**Host side.** The retry-exhaustion branch is `src/host-sweep.ts:296-302` (`if (msg.tries >= MAX_TRIES) { markMessageFailed(...); log.warn(... reason ...) }`). `reason` + `msg.id` are in scope. Immediately after `markMessageFailed`, call a new `recordTaskOutcome(getDb(), {...})` that writes to **central `data/v2.db`** (admin-visible, survives restarts → central per `docs/db.md`).

**Migration** — `src/db/migrations/020-task-outcomes.ts`, appended to the array in `src/db/migrations/index.ts` (latest committed is `019-container-config-env.ts`; use `version: 20`, unique `name`):

```sql
CREATE TABLE IF NOT EXISTS task_outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_group_id  TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  series_id       TEXT,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'failed',
  recorded_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_outcomes_group ON task_outcomes(agent_group_id);
```

No FK to `messages_in` (that row lives in a session DB). `markMessageFailed` is unchanged; only the call site records the outcome.

**Agent side (prompt-only).** Extend `container/agent-runner/src/mcp-tools/scheduling.instructions.md` (the `tasks/<slug>.md` convention is documented there): after each run, append one line to `/workspace/agent/tasks/<slug>.outcomes.md` (succeeded/failed, what went wrong, what to change) and read it first next run. These land in the RW group dir — no host code.

**Tests.** Host (`src/host-sweep.test.ts`): on `tries >= MAX_TRIES` a `task_outcomes` row is written with the right `reason`; on a normal retry none is. Migration idempotency test.

---

## Feature 1 — Budgeted `remember` MCP tool *(build second: establishes the round-trip helper + memory module + compose seam)*

> **✅ As built (`7a527c1`):** matches the plan. Round-trip template was the existing `ask_user_question` tool (in-process `writeMessageOut` + poll `findResponseById` + `markCompleted`), not the standalone `cli/ncl.ts`. Reply id is the deterministic `rem-resp-<requestId>` (exact-id lookup, not LIKE). Memory model = one entry per non-empty line; `replace`/`remove` match a unique substring of a line. Recompose-on-write calls `composeGroupClaudeMd` directly (no restart). Seeding lives at the top of `composeGroupClaudeMd` (`seedMemoryFiles`). Files: `container/agent-runner/src/mcp-tools/remember.ts` (+ `.instructions.md`, + test), `messages-in.ts` (`findResponseById`), `src/modules/memory/{budget,actions,index}.ts` (+ tests), `src/db/migrations/021-memory-budgets.ts`, `src/claude-md-compose.ts` (+ test), `src/cli/resources/groups.ts`, `src/db/container-configs.ts`, `src/types.ts`.

Two targets (`memory`→`MEMORY.md`, `user`→`USER.md`), three ops (`add` / `replace`-by-substring / `remove`-by-substring), **per-group** char budgets (default 2200 / 1375) that **error and return current entries** at capacity. Budget enforcement is **host-side** — the container doesn't hold the authoritative file text — so this is a **round-trip** tool.

**Per-group budgets (decision Q5).** Budgets are columns on `container_configs`, not constants. Migration `src/db/migrations/021-memory-budgets.ts` (`version: 21`):

```sql
ALTER TABLE container_configs ADD COLUMN memory_budget_chars INTEGER NOT NULL DEFAULT 2200;
ALTER TABLE container_configs ADD COLUMN user_budget_chars   INTEGER NOT NULL DEFAULT 1375;
```

The `remember` handler reads the budget for `session.agent_group_id` from `container_configs`. Wiring across the lifecycle:

- **At creation:** new groups inherit the column `DEFAULT` (the floor, 2200/1375) via `ensureContainerConfig`'s `INSERT OR IGNORE` — no code change needed for the default to apply. A brand-new Slack channel has an empty `CLAUDE.local.md`, so seed-to-fit (below) resolves to the floor anyway. To set a custom value inline at create, add optional `--memory-budget`/`--user-budget` flags to the group-create path (`src/cli/resources/groups.ts`).
- **After creation (editable anytime):** add `memory_budget_chars` / `user_budget_chars` to the typed key union in `updateContainerConfigScalars` (`src/db/container-configs.ts:62`) and expose `ncl groups config update --id <group> --memory-budget <n> --user-budget <n>` in `groups.ts` — same mechanism as `--model`. Works from the host CLI and from inside a container (with `--id` auto-filled) when `cli_scope` permits.

Changing a budget is a plain column write — no recompose or restart needed; it only affects the next `add`/`replace` capacity check.

**Seed-to-fit at migration (refined Q4/Q5).** For *existing* groups, the one-time CLAUDE.local.md→MEMORY.md step (below) also sets the initial budget to fit what it migrates: `memory_budget_chars = max(2200, ceil(len(migrated content) × 1.25))`. Migrating is **cost-neutral** — that content already loads in every prompt today via `CLAUDE.local.md` — so there is no truncation and no ceiling at seed. After seeding, the budget is fixed per group, so future growth beyond the seeded size still hits the wall and forces consolidation. The operator can raise/lower it anytime (above). Worked example from current groups: `slack_nanoclaw-introspection` (11,769 chars) → ~14,700; `slack_the-managers-guide` (8,291) → ~10,400; `slack_paul-graham-essays` (1,843) → 2,200 (floor).

**Source files** live at `groups/<folder>/MEMORY.md` and `groups/<folder>/USER.md`. The group dir is RW-mounted, but the host is the deliberate single writer so recomposition is deterministic.

**Seeding — migrate `CLAUDE.local.md` in (decision Q4).** A one-time, idempotent host step (top of `composeGroupClaudeMd`, guarded by `MEMORY.md` not yet existing): if `CLAUDE.local.md` has non-empty content, **move** it into `MEMORY.md` (operational bucket; `USER.md` starts empty), **set the group's `memory_budget_chars` to fit** (`max(2200, ceil(len × 1.25))`, see seed-to-fit above), then **blank `CLAUDE.local.md`** (replace with a one-line pointer comment). The blanking is essential — Claude Code auto-loads `CLAUDE.local.md` *separately* from the composed `CLAUDE.md` (`claude-md-compose.ts:140`), so leaving the content in both files would double-load it. No over-budget state ever arises: the budget is sized to the content at seed, and migration is cost-neutral (the content already loads today). Idempotent because the branch is keyed on `MEMORY.md` absence (mirrors the existing one-time cutover at `claude-md-compose.ts:146`).

**Container tool** — `container/agent-runner/src/mcp-tools/remember.ts` + `remember.instructions.md` (carries the Hermes "don't store" rules). Register like scheduling: `registerTools([rememberTool])` at module scope + `import './remember.js';` in `mcp-tools/index.ts`. The `.instructions.md` fragment is auto-discovered by `claude-md-compose.ts` filename convention — no compose change for it. Factor the `pollResponse` loop out of `cli/ncl.ts:91` into a shared helper so `remember` and `search_history` both reuse it.

System-action payload (container → outbound.db `content`):
```json
{ "action": "remember", "target": "memory"|"user",
  "op": "add"|"replace"|"remove",
  "text": "...", "match": "unique substring", "replacement": "...",
  "requestId": "rem-<ts>-<rand>" }
```
Host reply (host → inbound.db, `kind='system'`, `trigger=0`, id `rem-resp-<requestId>`): `{ ok, chars, budget }` on success; on overflow/ambiguous/zero-match: `{ ok:false, error, current:"<full file contents>", budget }`. **Returning the entries on failure is the defining Hermes behavior** — it forces consolidation.

**Host handler** — new `src/modules/memory/` (mirror `src/modules/scheduling/`): `registerDeliveryAction('remember', handleRemember)`; handler resolves the group folder, reads/writes the source file, enforces the budget, does unique-substring replace/remove (reject on absent/ambiguous match), inserts the reply via `insertMessage(inDb, { trigger:0, id:'rem-resp-'+requestId })` (reuse — do **not** hand-roll seq), then recomposes. Register the module in `src/modules/index.ts`.

**CLAUDE.md injection seam** — in `composeGroupClaudeMd` (`src/claude-md-compose.ts`), add two `type:'inline'` entries to the `desired` map whose content is the current `MEMORY.md`/`USER.md` text wrapped in a labeled block. They flow through the existing reconcile/write/import loop and land in `.claude-fragments/`, which is **RO-mounted** (`container-runner.ts:293`) — so the agent sees a frozen, prompt-cache-stable snapshot it cannot edit in place. If a file is absent, omit its fragment cleanly so reconcile doesn't thrash.

**Making a running container see an edit — DEFER (decision Q1).** The handler recomposes `CLAUDE.md` on edit, but the new frozen snapshot only takes effect at the next natural spawn — **no `restartAgentGroupContainers` on write.** This is correct, not a compromise: to call `remember`, the agent had to *produce* the text (add), or the match + replacement (replace), or the substring (remove) — so the fact is already in the writing session's context by construction. The injected snapshot only matters for *future* sessions. The single caveat: a concurrently-running sibling session in the same agent group won't see the edit until it respawns — inherent to shared memory, and consistent with Hermes's per-session-frozen model.

**Tests.** Container (`remember.test.ts`): per-op payload shape; tool-boundary validation; exactly one outbound row. Host (`src/modules/memory/actions.test.ts`): budget enforcement returns entries without mutating; unique/ambiguous/no-match replace+remove; reply inserted with `trigger=0`. Host regression (`claude-md-compose.test.ts`): inline fragments appear; absent files omit cleanly; reconcile prunes when disabled.

---

## Feature 2 — FTS5 search over conversation history *(build third: reuses #1's round-trip + #3's sweep slot)*

> **✅ As built:** matches the plan. **No central migration** — the index lives in its own host-only file `data/v2-index.db` (gitignored), opened at boot in `src/index.ts` (`initSearchIndexDb`, guarded — a failure disables search but doesn't stop the host). FTS5 schema = `messages_fts(agent_group_id UNINDEXED, source UNINDEXED, ref UNINDEXED, ts UNINDEXED, body)` + an `index_cursors` bookkeeping table (per-scope `seq` for messages, `mtime` for files). The single chokepoint `searchHistory(db, groupId, query, limit)` always ANDs `agent_group_id = ?` (an UNINDEXED column no MATCH expression can reference) onto the query; it tries the raw query first (FTS operators work) and falls back to a sanitized quoted-token form on a syntax error so a malformed query can never throw. Population (`src/search-index.ts` `indexSession`) runs in the 60s sweep — incremental by seq for `messages_in`/`messages_out` (skips `kind='system'` and any payload without string `text`), incremental by mtime for `conversations/*.md` (delete-by-ref + re-insert on change, no duplicates), capped 500 msgs / 25 files per session per tick, fully guarded. Round-trip reply id is `search-resp-<requestId>` (`trigger=0`). Files: `src/db/search-index-db.ts` (+ test), `src/search-index.ts` (+ test), `src/modules/search/{index,handler}.ts` (+ handler test), `src/host-sweep.ts`, `src/index.ts`, `src/modules/index.ts`, `container/agent-runner/src/mcp-tools/search_history.ts` (+ `.instructions.md`, + test), `mcp-tools/index.ts`.

**Index — shared file, scoped by column (decision Q3).** One host-only `data/v2-index.db` (better-sqlite3, host sole writer; FTS5 confirmed available in the bundled build, SQLite 3.49.2):
```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  agent_group_id UNINDEXED, source UNINDEXED, ts UNINDEXED, body );
```
Plus a bookkeeping table (last-indexed seq per session, last-indexed mtime per conversation file) for incremental re-indexing.

**Isolation safeguard.** Because isolation rests on a `WHERE agent_group_id = ?` clause rather than a separate file, the scope must be impossible to forget: all reads go through a **single chokepoint** `searchHistory(groupId, query, limit)` in `src/db/search-index-db.ts` that always binds `agent_group_id` — no caller composes raw MATCH SQL. A regression test asserts a cross-group query (group A's index rows, group B's id) returns zero results. This is the structural mitigation for the shared-index leak risk.

**Population** — in the **60s sweep** (`src/host-sweep.ts` `sweepSession`, which already opens each session's DBs), add `indexSessionMessages(...)`: pull new `messages_in` user messages + `messages_out` agent replies (incremental by seq) and new `groups/<folder>/conversations/*.md` (incremental by mtime; written by the container at `providers/claude.ts:248`), upsert into FTS. Factor into `src/search-index.ts` + `src/db/search-index-db.ts`. Keep per-tick work capped.

**Cross-mount decision** — the container cannot reach `data/v2-index.db` (only mounts its own session dir; a host-written WAL FTS db would also hit the VirtioFS mmap-coherency bug, `docs/db.md §4`). So `search_history` is a **round-trip**: container writes `{action:'search_history', requestId, query, limit}`, polls for `search-resp-<requestId>`; host `src/modules/search/` runs the FTS5 `MATCH` scoped to `session.agent_group_id`, formats top-N snippets, inserts the `trigger:0` reply. Zero new cross-mount invariants.

**Tool surface** — `container/agent-runner/src/mcp-tools/search_history.ts` + `.instructions.md`, input `{ query, limit? }`.

**Tests.** Host (`src/search-index.test.ts`): indexing from synthetic messages + temp conversation files; incremental re-index doesn't duplicate; MATCH scoped by `agent_group_id`. Host (`src/modules/search/handler.test.ts`): writes a `trigger=0` reply. Container (`search_history.test.ts`): request payload + poll-timeout.

---

## Feature 4 — Self-authored skills as procedural memory *(prompt-only, anytime)*

> **✅ As built (this branch):** matches the plan. New container skill `container/skills/learn-skill/SKILL.md` (auto-wired, no registration code) teaches the three Hermes triggers, the load-bearing "author a uniquely-named NEW dir under `/home/node/.claude/skills/<name>/`, never edit a symlinked shared skill in place" rule (a colliding name is `rmSync`'d at `container-runner.ts:398`), required `## Pitfalls` + `## Verification` sections, and patch-on-disproof. The only code change is a test seam: `syncSkillSymlinks` is still private, exposed via `export function _syncSkillSymlinksForTesting(...)` (mirrors the `_resetStuckProcessingRowsForTesting` convention in `host-sweep.ts:295`). Regression tests in `src/container-runner.test.ts` lock the invariant: a non-symlink unique-named dir survives both reconcile loops with contents intact; a stale symlink not in `desired` is removed; a real dir colliding with a desired name IS clobbered (documents the caveat); plus a skill-presence test asserting the SKILL.md carries the two required headers. Files: `container/skills/learn-skill/SKILL.md`, `src/container-runner.ts` (test-seam export only), `src/container-runner.test.ts`.

**Correctness verified.** `syncSkillSymlinks` (`src/container-runner.ts:344-404`) is **safe** for agent-authored skills: the removal loop only `unlinkSync`s entries that are *symlinks AND not in the desired set* (`:371`), and the clobber-replace only iterates the shared `desired` names (`:389-404`). A real directory the agent authors under `/home/node/.claude/skills/<name>/` (host: `data/v2-sessions/<group.id>/.claude-shared/skills/`) is not a symlink and not in `desired`, so it **survives the next spawn**. *Caveat:* the agent must author a uniquely-named new directory — a name colliding with a shared skill would be `rmSync`'d at `:397`.

**Deliverable** — new `container/skills/<self-authoring>/SKILL.md` teaching the three Hermes triggers (5+ tool calls & succeeded; error → fix found; user correction revealed better workflow), required **Pitfalls** + **Verification** sections, the "author a uniquely-named new dir, never edit symlinked shared skills in place" rule, and patch-on-disproof. No code change; auto-wired by existing skill machinery.

**Tests.** Host regression (`src/container-runner.test.ts`): a non-symlink dir in a temp `skills/` is **not** removed by `syncSkillSymlinks` while shared symlinks still reconcile — locks in the invariant. Skill-presence test that the SKILL.md has Pitfalls + Verification headers.

---

## Feature 5 — Weekly reflection recurring task *(build last: only pays off once 1–3 exist)*

> **✅ As built (this branch):** matches the plan — no new code. Seed template at `docs/templates/weekly-reflection.md`. The body is the task instructions; the leading HTML comment documents how to enable it for a group (copy into `groups/<folder>/tasks/weekly-reflection.md`, then schedule a recurring task whose `prompt` is the one-line pointer `Run task: tasks/weekly-reflection.md` with `recurrence: "0 9 * * 1"`). The body walks the agent through: gather signal (read recent `conversations/`, `search_history` for repeated topics, read every `tasks/*.outcomes.md`) → consolidate via `remember` (fold repeats with `replace`, prune stale with `remove`, respect the budget) → optionally author procedural memory per `learn-skill` → finish **silently** (no chat/email, output only via tool calls). Composes Features 1/2/3/4. **Seeded into the `main` group** (per the 2026-06-13 decision): the body was copied to `groups/main/tasks/weekly-reflection.md` and a recurring task (`0 9 * * 1` — Mondays 09:00 Europe/Amsterdam, first run `2026-06-15T07:00:00Z`) was inserted into main's base session `inbound.db` (`sess-1779373704233-eu40dq`, the one already holding morning-report/documentation-summary), routed `slack:C0AMA1R7EPK`/`slack`/empty-thread to match the existing recurring tasks. The row was created with a one-off script reusing the host's own `insertTask` + `cron-parser`+`TIMEZONE` (so seq parity, `series_id`, and first `process_after` are computed identically to the round-trip path); the script was deleted after running. Note: the task body's `remember`/`search_history` tools only exist once Features 1/2 are live (`pnpm run build` + restart); a fire before then degrades gracefully (silent, uses `conversations/` + outcomes files only). Files: `docs/templates/weekly-reflection.md`, `groups/main/tasks/weekly-reflection.md`.

**No new code.** A recurring task via the existing scheduling path (`schedule_task({ prompt:"<pointer>", recurrence:"0 9 * * 1" })`), body at `groups/<folder>/tasks/weekly-reflection.md` per the pointer convention. The body instructs the agent to review the week's `conversations/`, run `search_history` (#2) for recurring questions, read `tasks/*.outcomes.md` (#3), and consolidate into `MEMORY.md`/`USER.md` via `remember` (#1) — folding repeats in, pruning stale entries. Composes for free with `handleRecurrence` (`host-sweep.ts:210`). Only deliverable is the seed template.

---

## Build sequence & checkpoints

| Order | Feature | Why here | Checkpoint |
|-------|---------|----------|------------|
| 1 | #3 outcomes | smallest, independent, host-only | migration 020 applies on a `data/v2.db` copy; forced max-retry writes a row; `pnpm test` green |
| 2 | #1 remember | establishes round-trip helper + memory module + compose seam + budget migration 021 + CLAUDE.local.md seeding | add→replace→overflow returns entries; composed CLAUDE.md shows snapshot; CLAUDE.local.md migrated + blanked once; both test suites green |
| 3 | #2 search | reuses #1 helper + #3 sweep slot | index populates from real conversations + messages; scoped results; grep-proof container never opens the index |
| 4 | #4 skills | prompt-only; land the safety test first | sync test proves authored dirs survive; SKILL.md has required sections |
| 5 | #5 reflection | needs 1–3 to write into | recurring task fires, runs search, reads outcomes, calls remember |

After **each** feature: `pnpm test` (host vitest) **and** `cd container/agent-runner && bun test` must both be green before moving on.

---

## Risks / invariants (sturdiness is the top priority)

- **Seq parity (host=even, container=odd).** Round-trip replies must go through `insertMessage` (uses `nextEvenSeq`, `session-db.ts:89`); never hand-roll seq. Keep replies `trigger=0` so they don't spuriously wake/loop the agent.
- **Two-DB single-writer.** `data/v2-index.db` is a third host-owned DB — fine, host is sole writer. Hard rule: the container must **never** open it; enforce via round-trip + a grep regression assertion.
- **Shared-index isolation (Q3).** Search isolation rests on `WHERE agent_group_id = ?`, not a per-group file. The single-chokepoint `searchHistory()` query function + a cross-group regression test are the mitigation. Revisit per-group files only if the isolation model later demands hard filesystem separation.
- **CLAUDE.local.md double-load (Q4).** The seeding migration must blank `CLAUDE.local.md` after moving its content into `MEMORY.md`, else the text loads twice (Claude Code auto-load + injected fragment). Idempotent (keyed on `MEMORY.md` absence) so a re-run can't re-migrate an already-blanked file.
- **Cross-mount visibility.** Do not mount the index into the container (WAL + mmap bug). MEMORY/USER fragments live in the already-RO `.claude-fragments/`, re-read at spawn — no write contention.
- **Prompt-cache stability.** Inline MEMORY/USER snapshots are frozen per session by design (good). Decision Q1 is *defer* — no restart on write — so there is no mid-turn cache-bust. Never recompose on the 1s poll.
- **Sweep cost.** FTS indexing runs in the 60s sweep (per-session serial); keep it incremental (by seq/mtime) and capped per tick.
- **Supply-chain.** All work uses present deps; no new container packages, no `add_mcp_server`, no `minimumReleaseAge` bypass. FTS5 is confirmed available in the bundled `better-sqlite3` (SQLite 3.49.2) — no dependency decision needed.

---

## Resolved decisions (2026-06-13)

All five open questions are settled — no remaining blockers to start.

1. **Memory refresh → DEFER.** Recompose `CLAUDE.md` on edit; the new snapshot applies at the next natural spawn. No `restartAgentGroupContainers` on write. Correct because the writing session already holds the fact in context by construction (it produced the text to call the tool); the snapshot only matters for future sessions. Caveat: concurrent sibling sessions see the edit only after they respawn (inherent to shared memory).
2. **FTS5 → confirmed available** in the bundled `better-sqlite3` (SQLite 3.49.2). No dependency decision.
3. **Index scope → shared `data/v2-index.db` with an `agent_group_id` column.** Isolation enforced through a single chokepoint `searchHistory(groupId, …)` query function plus a cross-group regression test (structural mitigation for the shared-file leak risk).
4. **Seeding → migrate `CLAUDE.local.md` in, sized to fit.** One-time idempotent move of existing `CLAUDE.local.md` content into `MEMORY.md`, set the budget to `max(2200, ceil(len × 1.25))`, then blank `CLAUDE.local.md` to avoid double-loading. No over-budget state — cost-neutral (the content already loads today).
5. **Budgets → per-group configurable** via `container_configs` columns (`memory_budget_chars` default 2200, `user_budget_chars` default 1375), migration 021. New groups inherit the floor (or an optional create-time flag); editable anytime via `ncl groups config update --memory-budget/--user-budget` — a plain column write, no restart. Seed-to-fit sets the initial value for migrated groups. CLAUDE.md itself is a poor proportionality signal (~478 B of imports, near-constant); the real signal is `CLAUDE.local.md`, which is what seed-to-fit measures.

### Migration numbering (claimed)

- `020-task-outcomes.ts` — Feature 3 `task_outcomes` table.
- `021-memory-budgets.ts` — Feature 1 budget columns on `container_configs`.

(`019-container-config-env.ts` is already taken by the container-env/paywall-browser feature.)
