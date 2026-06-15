# Section 01 — Learning & Memory Layer

The fork's flagship subsystem (Hermes-inspired). Five capabilities, each with a host
side and (for remember/search) a container side. Read the "Round-trip tool
architecture" note in `index.md` first.

Budget defaults are load-bearing (seed-to-fit): **MEMORY.md = 2200 chars, USER.md =
1375 chars**. Don't change without re-profiling.

---

## 1.1 `remember` tool — budgeted MEMORY.md / USER.md

**Origin:** fork-original. **Commits:** `7a527c1 feat(learning): budgeted 'remember' tool`, `3111cf4 fix formatting`.

**Intent:** Agent-curated persistent memory across sessions. `MEMORY.md` (operational
lessons) and `USER.md` (user profile) live in the group dir, injected into the system
prompt each session. Agent edits via `remember {target, op, text/match/replacement}`.
Round-trip: container writes a `remember` action to `outbound.db`; host applies the edit
with char-budget enforcement and recomposes CLAUDE.md; replies on `inbound.db`.

**HOST side — files:** `src/modules/memory/budget.ts` (new), `src/modules/memory/actions.ts`
(new), `src/modules/memory/index.ts` (new), `src/modules/memory/budget.test.ts` (new),
`src/modules/memory/actions.test.ts` (new), `src/modules/index.ts` (add barrel import).

How to apply (host):
1. Create `src/modules/memory/budget.ts` — pure logic, no I/O. Exports:
   - `type MemoryOp = 'add' | 'replace' | 'remove'`
   - `interface MemoryOpParams { text?, match?, replacement? }`
   - `type MemoryOpError = 'empty_text'|'empty_match'|'empty_replacement'|'no_match'|'ambiguous_match'|'budget_exceeded'|'invalid_op'`
   - `interface MemoryOpResult { ok, content?, error?, chars, budget }`
   - `function applyMemoryOp(current: string, op: MemoryOp, params: MemoryOpParams, budget: number): MemoryOpResult`
   Invariants: `add` collapses embedded newlines (one add = one line/entry); `replace`/`remove`
   match by UNIQUE substring (no-match and ambiguous-match are both errors); `remove` never hits
   budget; `add`/`replace` fail with `budget_exceeded` returning current chars so the agent can
   consolidate. (Recover full body from `git show 971239a:src/modules/memory/budget.ts`.)
2. Create `src/modules/memory/actions.ts`. Imports: `fs`, `path`, `better-sqlite3`,
   `composeGroupClaudeMd` (from `../../claude-md-compose.js`), `GROUPS_DIR` (from `../../config.js`),
   `getAgentGroup`, `getContainerConfig`, `insertMessage` (from `../../db/session-db.js`), `log`,
   `Session` type, `applyMemoryOp`/`MemoryOp`. Constants:
   ```ts
   const DEFAULT_MEMORY_BUDGET = 2200;
   const DEFAULT_USER_BUDGET = 1375;
   const TARGET_FILES: Record<string, string> = { memory: 'MEMORY.md', user: 'USER.md' };
   ```
   Handler `export async function handleRemember(content, session, inDb): Promise<void>`:
   resolves group + budget (per-group override from `container_configs.memory_budget_chars` /
   `user_budget_chars`), reads current file, calls `applyMemoryOp`, on success writes the file
   ATOMICALLY (`writeFileSync` tmp + `renameSync`) and calls `composeGroupClaudeMd(group)`, then
   writes reply row `rem-resp-<requestId>` to `inDb` with **`trigger=0`** (frame `{ok, chars,
   budget}` or `{ok:false, error, content}` so the agent sees current entries to consolidate).
3. Create `src/modules/memory/index.ts`:
   ```ts
   import { registerDeliveryAction } from '../../delivery.js';
   import { handleRemember } from './actions.js';
   registerDeliveryAction('remember', handleRemember);
   ```
4. In `src/modules/index.ts` append `import './memory/index.js';`.
5. Recreate the two `*.test.ts` from `971239a`. Note the test uses an absolute `GROUPS_DIR`
   so `path.resolve(GROUPS_DIR, folder)` redirects writes to a temp dir — preserve that trick.

**CONTAINER side — files:** `container/agent-runner/src/mcp-tools/remember.ts` (new),
`remember.instructions.md` (new), `remember.test.ts` (new),
`container/agent-runner/src/db/messages-in.ts` (add `findResponseById`),
`container/agent-runner/src/mcp-tools/index.ts` (add barrel import).

How to apply (container):
1. In `container/agent-runner/src/db/messages-in.ts` add (uses `openInboundDb()` — a FRESH
   read-only connection closed in `finally`; critical for cross-mount visibility of host writes —
   do NOT switch to the cached `getInboundDb()`):
   ```ts
   export function findResponseById(id: string): MessageInRow | undefined {
     const inbound = openInboundDb();
     const outbound = getOutboundDb();
     try {
       const response = inbound.prepare("SELECT * FROM messages_in WHERE id = ? AND status = 'pending'").get(id) as MessageInRow | undefined;
       if (!response) return undefined;
       const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
       if (acked) return undefined;
       return response;
     } finally { inbound.close(); }
   }
   ```
2. Create `mcp-tools/remember.ts`. Tool `remember`, schema `{ target:'memory'|'user'
   (required), op:'add'|'replace'|'remove' (required), text?, match?, replacement? }`. Handler:
   validate args; `requestId = rem-${Date.now()}-${random}`; `writeMessageOut({ id: requestId,
   kind:'system', content: JSON.stringify({ action:'remember', requestId, target, op, text, match,
   replacement }) })` with routing from `getSessionRouting()`; poll `findResponseById('rem-resp-'
   + requestId)` every 500ms up to 30s; on receipt `markCompleted([resp.id])`, parse
   `frame`; success → `"Saved to {target} ({chars}/{budget} chars used)."`; budget/no-match/
   ambiguous → error text including current entries; timeout → error. `registerTools([remember])`.
3. Create `remember.instructions.md` (from `971239a`) — loaded as agent guidance.
4. In `mcp-tools/index.ts` add `import './remember.js';` (after `self-mod`).
5. Recreate `remember.test.ts`.

**DB dependency:** migration adding `memory_budget_chars` + `user_budget_chars` to
`container_configs` (fork's 021 — see §1.5) and the `container-configs.ts` scalar wiring.

---

## 1.2 `search_history` tool — FTS5 conversation search

**Origin:** fork-original. **Commit:** `1d0172d feat(learning): FTS5 'search_history'`.

**Intent:** Full-text search over the group's own past inbound/outbound + archived
transcript rows via FTS5 index at `data/v2-index.db` (separate file — avoids lock
contention with `data/v2.db`). Round-trip tool (container can't open the host index DB:
only its session dir is mounted, WAL-over-VirtioFS has mmap coherency issues).

**HOST side — files:** `src/db/search-index-db.ts` (new), `src/db/search-index-db.test.ts`
(new), `src/search-index.ts` (new), `src/modules/search/handler.ts` (new),
`src/modules/search/index.ts` (new), `src/modules/search/handler.test.ts` (new),
`src/modules/index.ts` (barrel), `src/host-sweep.ts` (indexer call), `src/index.ts` (init).

How to apply (host):
1. Create `src/db/search-index-db.ts` (~222 lines). Opens `data/v2-index.db`; creates
   `messages_fts` FTS5 virtual table (cols `ref, agent_group_id, role, content`) and
   `index_cursors (agent_group_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0)`.
   Exports `getSearchIndexDb()`, `initSearchIndexDb(path)`, `closeSearchIndexDb()`,
   `getCursor`/`setCursor`, `indexRows(db, rows)`, `deleteByRef(db, ref)`,
   `searchHistory(db, agentGroupId, query, limit?): SearchHit[]`, `type SearchHit`. The
   `searchHistory` function is the SOLE query chokepoint — it ALWAYS ANDs `agent_group_id = ?`
   (group isolation — privacy-critical, do not weaken) and sanitizes FTS5 special chars.
   Default limit 10, max 50. (Recover from `git show 971239a:src/db/search-index-db.ts`.)
2. Create `src/search-index.ts` (~182 lines). Exports `indexSession(args: IndexSessionArgs)`
   which reads new rows since the cursor from a session's DBs + the group's conversation
   markdown archive and calls `indexRows`/`setCursor`.
3. Create `src/modules/search/handler.ts`. `export async function handleSearchHistory(content,
   session, inDb): Promise<void>` — writes reply `search-resp-<requestId>` with `trigger=0`;
   `{ok:false, error:'index_unavailable'}` when `getSearchIndexDb()` is null; `{ok:false,
   error:'empty_query'}` on blank; `{ok:true, query, results}` on success (scoped to
   `session.agent_group_id`).
4. Create `src/modules/search/index.ts`:
   ```ts
   import { registerDeliveryAction } from '../../delivery.js';
   import { handleSearchHistory } from './handler.js';
   registerDeliveryAction('search_history', handleSearchHistory);
   ```
5. In `src/modules/index.ts` append `import './search/index.js';`.
6. In `src/index.ts`: `import { initSearchIndexDb } from './db/search-index-db.js';` and after
   central DB ready, `initSearchIndexDb(path.join(DATA_DIR, 'v2-index.db'))` (try/catch).
7. In `src/host-sweep.ts` `sweepSession`, after the recurrence hook, add a best-effort
   try/catch calling `getSearchIndexDb()` then `indexSession({...})` (failure never aborts sweep).
8. Recreate `search-index-db.test.ts` + `modules/search/handler.test.ts`.

**CONTAINER side — files:** `mcp-tools/search_history.ts` (new), `search_history.instructions.md`
(new), `search_history.test.ts` (new), shares `findResponseById` (§1.1), `mcp-tools/index.ts`.

How to apply (container): create `mcp-tools/search_history.ts` — tool `search_history`,
schema `{ query: string (required), limit?: number }` (default 10, max 50). `requestId =
srch-${Date.now()}-${random}`; writes `{action:'search_history', requestId, query, limit}`;
polls `findResponseById('search-resp-' + requestId)`; formats hits as `"N match(es) for
\"<query>\":\n- [<who> <date>] <snippet>"` with `SOURCE_LABELS = { in:'user', out:'you',
conversation:'transcript' }`. `registerTools([searchHistory])`. Add `import
'./search_history.js';` to `mcp-tools/index.ts`. Recreate instructions.md + test.

---

## 1.3 Task-outcome log

**Origin:** fork-original. **Commits:** `2fd5f4f feat(learning): task outcome log + design docs`, `3111cf4`.

**Intent:** Persist per-task outcomes (failed/timeout/etc.) to `task_outcomes` in the
central DB to feed the weekly reflection / learning pass.

**Files:** migration (fork's `020-task-outcomes.ts` — see §1.5), `src/db/task-outcomes.ts`
(new), `src/db/task-outcomes.test.ts` (new), `src/db/session-db.ts` (extend
`getMessageForRetry`), `src/host-sweep.ts` (record on stale reset).

How to apply:
1. Create `src/db/task-outcomes.ts` (~61 lines): `recordTaskOutcome(db, outcome)` (INSERT,
   guards on table existence for pre-migration safety) and `listTaskOutcomes(db, agentGroupId)`
   (SELECT scoped by `agent_group_id`).
2. In `src/db/session-db.ts`, extend `getMessageForRetry` return type + SQL to include `kind`
   and `series_id as seriesId`. (Check upstream's current signature before editing.)
3. In `src/host-sweep.ts` `resetStuckProcessingRows`, after the failed-message log, add a
   best-effort try/catch: `recordTaskOutcome(getDb(), { agentGroupId, sessionId, messageId,
   seriesId, kind, reason })` (import `recordTaskOutcome` from `./db/task-outcomes.js`, `getDb`
   from `./db/connection.js`). Failure must never abort the reset.
4. Recreate `task-outcomes.test.ts`.

---

## 1.4 Self-authored skills + weekly reflection (Features 4 & 5)

**Origin:** fork-original. **Commit:** `8c48db4 feat(learning): self-authored skills + weekly reflection`.

- **`learn-skill` container skill** — `container/skills/learn-skill/SKILL.md`. Teaches the agent
  the 3 triggers to author a new skill, the hard rule to author under a UNIQUELY-named
  non-colliding directory (shared skills are symlinks wiped on spawn collision — see the
  symlink shadow-dir fix in §06), required `## Pitfalls` + `## Verification` sections, and the
  patch-on-disproof maintenance rule. **Apply:** copy `container/skills/learn-skill/` as-is.
  Effectiveness depends on the `container-runner.ts` symlink reconciliation fix (§06).
- **`reporting` container skill** — `container/skills/reporting/instructions.md` (note:
  `instructions.md`, not `SKILL.md` — an always-loaded instruction fragment). Consolidates
  report-style rules (summary-first, omit-empty, Slack `*single-asterisk*` bold, Block Kit
  fallback, email shape, single-message, source attribution). **Apply:** copy
  `container/skills/reporting/` as-is. Verify the clean upstream skill loader loads
  `instructions.md` fragments; the `<!-- Provenance -->` block lists 4 source channel
  `CLAUDE.local.md` files — re-audit before editing those. (Commit `de293f5` is the standalone
  reporting-skill commit.)
- **Weekly reflection** — template at `docs/templates/weekly-reflection.md` (copy as-is). The
  reflection is driven as a scheduled task per the externalized-task convention (see §05 and
  `scheduling.instructions.md` in §03).

---

## 1.5 Migrations 020 (task-outcomes) & 021 (memory-budgets)

**Origin:** fork-original. See §1.3 / §1.1 for the table consumers.

**RENUMBERING REQUIRED (decision #1 — accept upstream's migrations):** On clean upstream,
`ls src/db/migrations/` first. Upstream now owns numbers the fork also used (notably 016 =
`016-messaging-group-instance.ts`). Assign fork migrations the NEXT FREE numbers after
upstream's highest, in this relative order: reply-mode (§05), reply-mode-channel-default
(§05), default-model-opus (§05), container-config-env (§04), task-outcomes, memory-budgets.
Register each in `src/db/migrations/index.ts` in numeric order.

- **task-outcomes migration** — `CREATE TABLE IF NOT EXISTS task_outcomes (id TEXT PRIMARY KEY,
  agent_group_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, series_id TEXT,
  kind TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, recorded_at TEXT NOT NULL)` + index
  `idx_task_outcomes_group ON task_outcomes(agent_group_id)`.
- **memory-budgets migration** — `ALTER TABLE container_configs ADD COLUMN memory_budget_chars
  INTEGER NOT NULL DEFAULT 2200;` and `... user_budget_chars INTEGER NOT NULL DEFAULT 1375;`.
  Then in `src/db/container-configs.ts`: add constants `DEFAULT_MEMORY_BUDGET=2200`,
  `DEFAULT_USER_BUDGET=1375`; add both columns to `SCALAR_COLUMNS`, the `createContainerConfig`
  INSERT, and the `updateContainerConfigScalars` Pick type.

**Migration runner note (`src/db/migrations/index.ts`):** Per decision #1, KEEP upstream's
runner shape (including its FK-violation infrastructure `disableForeignKeys`/`FkViolation`/
`fkIdentity`/`list` param if present). The fork had simplified it by stripping those — do NOT
carry that removal forward. Only add the fork's new migration imports/array entries on top of
upstream's runner.
