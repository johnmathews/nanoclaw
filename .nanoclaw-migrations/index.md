# 1. NanoClaw migration guide — Phase 2 onto v2026.10.0

Refreshed: **2026-11-02**. Verified against upstream tag **`v2026.10.0`** (2026-10-09).
Fork HEAD at refresh: `e35bb0dd`. Merge-base with upstream: `acbb1144b` (2026-06-15).

This guide lets a fresh session reproduce this fork's customizations on a clean upstream
checkout (intent-based migration, not merge). The six section files hold the detailed
intents; **this index is authoritative where it contradicts them**, because they were
written against June's upstream and have not been rewritten.

## 1.1 What changed since the last version of this guide

The previous index (`index-2026-06-15-executed.md`, kept for provenance) planned a replay
onto upstream **2.1.16**. That replay **was executed** — commit `1c9ff93c
"migrate: rebuild fork customizations on upstream 2.1.16 (intent-based)"`. So the current
tree already *is* upstream 2.1.16 plus replayed customizations, plus **42** fork commits
made since.

This refresh therefore plans a **second** replay, onto a much more distant base:

| | June 2026 replay | This replay |
|---|---|---|
| Target | upstream 2.1.16 | upstream **v2026.10.0** |
| Upstream commits to absorb | ~40 | **1129** |
| `[BREAKING]` items to action | few | **19** |
| Customization set | the 6 section files | the 6 section files **+ §7 (42 commits)** |

## 1.2 Why intent replay rather than merge

Upstream re-architected the layers this fork edits. Merging 1129 commits into 43 fork
commits produces semantic conflicts (fork code calling APIs that no longer exist), not
textual ones, and the known local failure mode is a merge that builds clean and silently
drops behaviour. Relevant upstream churn since the merge-base: `container-runner.ts` 39
commits, `delivery.ts` 21, `host-sweep.ts` 17, `router.ts` 15, `index.ts` 10.

## 1.3 Structural changes that invalidate assumptions in the section files

Read this before touching any section file. Each of these breaks instructions written in
June.

| Change | Consequence for the replay |
|---|---|
| **`src/db/session-db.ts` is gone.** Replaced by `src/mailbox/` (`compose.ts`, `model.ts`, `registry.ts`, `sqlite/`, `types.ts`) plus `src/db/driver.ts` + `driver-registry.ts` + `drivers/`. | Every `insertMessage` / session-DB call in a ported module must be rewritten against the mailbox API. Affects §1.2 and §1.3 directly. |
| **Central DB access is async behind `DbDriver`** (BREAKING). Migrations gained `migrate.ts`, `registry.test.ts`, `portability.test.ts`. | Ported DB code must be `async`. Migration bodies take `await db.exec(...)`. |
| **Container runtime moved behind a session-driver seam** (BREAKING). New `src/drivers/`, `src/guard/`, `src/provider-contracts/`. | §4.1 step 5, §6.2, and the telemetry fix (§7) all edit `container-runner.ts` and must be redesigned, not pasted. |
| **`src/claude-md-compose.ts` → `src/project-doc-compose.ts`** (BREAKING), exporting `composeGroupProjectDoc`, `DEFAULT_PROJECT_DOC`, `renderBaseInstructions`. | Any `composeGroupClaudeMd` import must be retargeted. |
| **Host modules use one lifecycle registry** — `src/host-lifecycle.ts` (BREAKING). | Modules importing `onShutdown()`/`getShutdownCallbacks()` from `response-registry.js` must move. |
| **Migrations now run 001–025.** Upstream owns 016–025 with *different* content than the fork's 016–021. | Renumber fork migration **files** to 026+ for tidiness — but this is **not** the collision risk the June guide claimed. The ledger keys on `name`, not `version`: see §1.11, verified empirically. |
| **Credential gateways install through skills** (BREAKING). Upstream `package.json` has **no** `@onecli-sh/sdk` dependency; OneCLI lives in `.claude/skills/add-onecli/`. | Supersedes locked decision #2 — see §1.4 below. |
| **Chat SDK + adapters pinned to `4.29.0`** exactly (BREAKING). Fork used 4.26.0. | Use upstream's pin, never the fork's. |
| **`slack-formatting` / `whatsapp-formatting` container skills moved to the `channels` branch** (BREAKING); they install with their channel. | Do **not** port the fork's copies. |
| **Scheduled tasks moved from MCP tools to `ncl tasks`** (BREAKING, 27 upstream files). | The fork's MCP scheduling is superseded; `feedback_task_prompts_external` still applies to whatever replaces it. |
| **Provider-agnostic file-based memory** (BREAKING) — `groups/<folder>/memory/` mounted into the container, agent edits with ordinary file tools; `container/agent-runner/src/memory/{context,hook,session-hook,scaffold}.ts` + templates; `docs/memory.md`; `/migrate-memory` skill. | Supersedes the fork's `remember` round-trip — see §2.1. |
| Upstream added `src/slash-command.ts` (parsing helpers only: `commandText`, `slashCommandName`, `withoutBotSuffix`). | §5.1's host-responder gate is still needed, but should build on these helpers. |

## 1.4 Operator decisions — restated

1. **Channel-instance / multi-instance dimension → ACCEPT DORMANT.** Unchanged and still
   correct. Build on upstream as-is; never re-remove upstream's `instance` column, routing
   args or migrations. Where a fork commit removed instance code, re-apply **only** the
   fork's net feature on top.
2. **OneCLI → ~~target SDK 2.2.1 + gateway upgrade~~ → OBSOLETE, REPLACED.** Clean upstream
   has no OneCLI dependency at all. Instead: run **`/add-onecli`**, whose
   `.claude/skills/add-onecli/versions.json` at this tag pins
   `onecli-gateway 1.42.0`, `onecli-cli 2.2.5`, `onecli-sdk 2.2.1` — **exactly what this
   host already runs** (gateway and CLI upgraded 2026-11-01, commit `94ffd670`). No gateway
   work is needed during Phase 2, and 1.43+ remains unsupported. Do not target
   `upstream/main`, which requires gateway 1.45 + the grants migration.
3. **Target the tag, not `main`.** `v2026.10.0` is the stable release carrying the four
   symlink host-FS-escape CVEs, the `/clear` + `/upload-trace` permission bypass fix and the
   `ncl` cross-group bypass fix. It is 110 commits behind `upstream/main`.

## 1.5 Verdict matrix

Every item in the section files, re-verified against `v2026.10.0`. **PORT** = still
fork-only, carry it over. **REWORK** = still needed but the instructions are invalid as
written. **DROP** = upstream covers it, or it no longer applies.

### 1.5.1 Section 01 — learning & memory

| Item | Verdict | Why |
|---|---|---|
| 1.1 `remember` tool + budgets | **DROP / redesign** | Upstream ships file-based memory the agent edits directly, which removes the reason the fork's host round-trip existed. Adopt upstream's `memory/` tree; carry forward only the char-budget *discipline* (2200 / 1375) as guidance text in `memory/system/definition.md`. Read `docs/memory.md` first. |
| 1.2 `search_history` (FTS5) | **PORT (rework)** | 0 upstream files. `registerDeliveryAction` survives (7 files), so the round-trip pattern is still viable — but the reply write must move from `session-db.ts` to `src/mailbox/`, and the `host-sweep.ts` indexer hook point has changed. |
| 1.3 task-outcome log | **PORT (rework)** | `task_outcomes` / `recordTaskOutcome`: 0 upstream. `getMessageForRetry` still exists (4 files) — re-check its home and signature before extending. |
| 1.4 `learn-skill`, `reporting`, weekly-reflection template | **PORT** | Upstream `container/skills/` holds only `agent-browser`, `frontend-engineer`, `self-customize`, `welcome`. Check upstream's new host-side `learn` skill for overlap with `learn-skill` first. |
| 1.5 migrations 020/021 | **PORT (renumber)** | Renumber to 026+; keep upstream's async runner shape. |

### 1.5.2 Section 02 — channels

| Item | Verdict | Why |
|---|---|---|
| Pinned versions | **REWORK** | `chat` is `4.29.0` upstream, exact-pinned by BREAKING. Discard the fork's 4.26.0 list. |
| 2.1 bridge: multimodal, reactions, blocks/card | **PORT (rework)** | Still fork-only, but `src/channels/chat-sdk-bridge.ts` gained upstream suites (agent-mode, dm-thread, inbound-policy, membership, raw-text) — re-apply onto the new file, don't diff-paste. |
| 2.1 approval-card actor byline | **DROP** | Upstream has it: `src/channels/chat-sdk-bridge-byline.test.ts` ships at this tag. |
| 2.2 Slack `send_blocks` + `postBlocks` | **PORT (rework)** | Still fork-only, but BREAKING #4 reworked the Slack experience (per-agent provisioned apps, agent spawning) and added `slack-a2a-rooms`, `slack-agent-flow`, `migrate-slack-agents`. Read upstream `slack.ts` before applying. |
| 2.3 WhatsApp spill + `classifyConnectionClose` + Baileys v7 | **PORT** | Still fork-only. |
| `slack-formatting` / `whatsapp-formatting` skills | **DROP** | Ship with their channel skills now. |

### 1.5.3 Section 03 — multimodal & reactions

**All PORT** — verified 0 upstream files for every piece: `multimodal.ts`,
`ImageContentBlock` / `supportsMultimodalContent`, `query_reactions`, `pdf-extract.ts`,
`transcription.ts`, the `reactions` container skill. The only caveat is that
`providers/claude.ts`, `poll-loop.ts` and `formatter.ts` have moved on upstream, so apply
by intent.

### 1.5.4 Section 04 — container env & build

| Item | Verdict | Why |
|---|---|---|
| 4.1 per-group `env` + reserved-key guard | **PORT (rework step 5)** | 0 upstream files. The `container-runner.ts` edit must be redone against the session-driver seam. |
| 4.2 Dockerfile Gmail/GCal MCP layer | **PORT** | Upstream keeps `cli-tools.json` + `install-cli-tools.sh`, so the layer still slots in — but adopt upstream's pins (`BUN_VERSION=1.4.0`, `PNPM_VERSION=10.34.5`, `NPM_VERSION=10.9.9`), not the fork's. |
| `add-gmail-tool` / `add-gcal-tool` skills | **PORT (newly identified)** | Not in upstream's skill set — these are fork-local and the section files never listed them. |
| 4.3 `capabilities`, `status`, `pdf-reader`, `email-sending` skills | **PORT** | No upstream equivalents. |
| `onecli-gateway` container skill | **DROP** | Comes from `/add-onecli`. |
| `vercel-cli` container skill | **DROP** | Comes from `/add-vercel`. |

### 1.5.5 Section 05 — health, ops & defaults

| Item | Verdict | Why |
|---|---|---|
| 5.1 `respond` host-responder gate | **PORT (rework)** | `HOST_RESPONDER`: 0 upstream. Build on `src/slash-command.ts` helpers; `command-gate.ts`, `router.ts`, `delivery.ts`, `host-sweep.ts` all moved. |
| 5.2 `/health` + systemd watchdog + `/status` | **PORT** | 0 upstream. `src/liveness.ts` is session-claim liveness, not host health — no overlap. |
| 5.3 `/usage` + `ncl usage` | **PORT** | 0 upstream. |
| 5.4 default model Opus 4.7 (migration 017) | **DROP — replaced by config** | Upstream reads `NANOCLAW_DEFAULT_MODEL` (`src/config.ts:47`) and applies it as the per-group fallback (`src/container-config.ts:380`). Set `NANOCLAW_DEFAULT_MODEL=claude-opus-4-7` in `.env`; drop the migration and the hardcoded constant. Honours the standing Opus-default rule with less code. |
| 5.5 per-channel `reply_mode` | **PORT (renumber)** | 0 upstream; add as new migrations after 025, keeping upstream's `instance` column. |
| 5.6 OneCLI identifier `oc-` sanitization | **PORT (check first)** | 0 upstream at top level, but OneCLI code now lives in `.claude/skills/add-onecli/payload/src/gateway-providers/` — check there before re-adding. |
| 5.7 `create_agent` provider-inheritance removal | **DROP** | Already recommended as skip; unchanged. |

### 1.5.6 Section 06 — infra fixes & config

| Item | Verdict | Why |
|---|---|---|
| 6.1 `<internal>` tag stripping | **PORT** | `stripInternalTags` exists in upstream `formatter.ts` but `mcp-tools/core.ts` does not call it. |
| 6.2 symlink shadow-dir fix | **PORT (rework)** | No `isSymbolicLink` handling upstream. High-risk file. |
| 6.3 install-slug de-`v2` | **PORT — load-bearing** | Upstream still emits `-v2-` infixes. Without this, a rebuilt install's unit/image names become `nanoclaw-v2-583cc1c4`, breaking continuity with the running `nanoclaw-583cc1c4` service. |
| 6.4 mount-security test port | **DROP** | Upstream ships `src/modules/mount-security/index.test.ts`. |
| 6.5 `/update-nanoclaw` diagnostics opt-out | **DROP** | Upstream removed Step 0a, Step 7.9 and the Diagnostics section; there is no `diagnostics.md`. |
| 6.6 package.json pins | **REWORK** | See decision #2 — no OneCLI dep upstream; channel deps come from their skills at upstream's pins. `pnpm-workspace.yaml` stays verbatim, never loosened. |
| 6.7 misc config (`.gitignore`, husky, settings) | **PORT (selective)** | Unchanged. |
| 6.8 Paul Graham essay scripts | **PORT (optional)** | Only if recreating that group. |
| 6.9 docs | **PORT** | Unchanged, but retarget prose naming `claude-md-compose` → `project-doc-compose`. |

## 1.6 Section 07 — fork work since the June rebuild

**42 fork-local commits** (`1c9ff93c..HEAD`) post-date every section file and were not
documented anywhere. Inventory and classification: `07-since-june-rebuild.md`. The two
non-trivial ports it identified are extracted in full in `08-deep-intents.md` (silent-turn
recovery; the outbound-loss guard, rebased onto upstream's `delivery_attempts` table). A
third, reject-with-reason, proved to be upstream's own feature — §8.3 records the correction.

The two largest clusters in §7 — a2a per-message approval policies and the approvals approver
model — are upstream features at this tag, so they become "adopt upstream, then diff the
nuances" rather than ~20 commits of replay.

## 1.7 Order of operations

Validate with `pnpm run build && pnpm test` after each numbered stage.

1. **Checkout + skills** — clean `v2026.10.0`; run `/add-onecli` (pins the gateway this host
   already runs), then `/add-whatsapp`, `/add-slack`, `/add-resend`.
2. **DB migrations** — convert bodies to the async `DbDriver` shape and register in
   upstream's runner, **keeping each migration's `name` string byte-identical** to what the
   live ledger already records (§1.11). Version numbers are only ordering hints; pick 026+.
3. **Host standalone modules** — the files with no upstream conflict (`search-index*`,
   `task-outcomes`, `pdf-extract`, `transcription`, `health*`, `watchdog`, `usage`,
   `onecli-identifier`, `modules/search/*`). Re-verify each path still has no upstream
   counterpart before copying.
4. **Host edits to upstream files** — rewrite against the new seams: mailbox, `DbDriver`,
   session-driver, `host-lifecycle`, `project-doc-compose`.
5. **Channels** — re-apply the §02 modifications on top of the installed adapters.
6. **Container agent-runner** — §03 multimodal/reactions, §6.1 stripping.
7. **Container build surface** — Dockerfile MCP layer, container skills (porting only the
   four-plus-two that survive the matrix).
8. **§7/§8 items** — the 42 commits, per `07-since-june-rebuild.md` and the full
   intents in `08-deep-intents.md`.
9. **Config** — `.env` gains `NANOCLAW_DEFAULT_MODEL=claude-opus-4-7`; misc config from §6.7.
10. **Validate + live round-trip** — host build + tests, container typecheck + `bun test`,
    container image build, then post into `#nanoclaw-introspection` (Slack `C0AMETJFW9X`)
    and confirm a reply lands.

## 1.8 Round-trip tool architecture

Still accurate in shape, and still required for `search_history` (the container cannot open
the host's index DB). Container MCP tool writes a `system` action row to `outbound.db` → the
host delivery layer handles the action and writes a deterministically-named reply
(`search-resp-<id>`) into the inbound mailbox with `trigger=0` (no re-wake) → the container
polls `findResponseById` until it arrives. **Both halves must be ported or the tool times
out after 30s.**

Two changes: the inbound write goes through `src/mailbox/` rather than
`src/db/session-db.ts`, and this pattern is **no longer needed for memory** — upstream mounts
the group's `memory/` directory into the container so the agent writes it directly.

## 1.9 Do not port

Install-specific one-offs and already-applied data migrations:

- `scripts/ft-kickoff.ts`, `scripts/init-ft-channel.ts` — one-off `#financial-times`
  bootstrap with hardcoded IDs. Use `/manage-channels`.
- `scripts/close-non-winner-sessions.ts`, `scripts/externalize-task-prompts.ts` — one-shot,
  already applied.
- `scripts/setup-ritsya-job-search.ts` — one-off group create. Use `/manage-channels`.
- `groups/**`, `data/**`, `store/**`, `.env`, `journal/**` — install data and content.
- `.claude/settings.json` `Bash(gh run watch *)` — local convenience permission.

## 1.10 Verification checklist

After Phase 2: every new module registered in its barrel (`src/modules/index.ts`,
`container/agent-runner/src/mcp-tools/index.ts`); migrations run cleanly on a fresh DB in
numeric order; host build + `pnpm test` green; container typecheck + `bun test` green;
container image builds; the running service name still matches (§6.3); a live
`#nanoclaw-introspection` round-trip returns a reply; and a gateway credential-injection
probe returns `injections_applied=1` (see `docs/onecli-upgrades.md` §1.3).

## 1.11 Migration ledger — verified, and not the risk we thought

**Tested 2026-11-02/04 against copies of the live `data/v2.db`. The live database was never
touched.** This replaces the June guide's claim that "migration numbering is the single
biggest collision risk".

Upstream's runner selects pending migrations **by `name`, not by `version`** — its own comment
says so, and the behaviour is confirmed:

> *Uniqueness is keyed on `name`, not `version`. … `version` stays on the Migration object as
> an ordering hint within the barrel array; the stored `version` column is auto-assigned at
> insert time as an applied-order number.*

So the fork's drifted numbering is irrelevant. The live ledger holds 22 rows whose numbers
diverge from upstream's from version 5 onward, but whose **names** line up: 16 are upstream
migrations under different numbers, 6 are fork-only.

### 1.11.1 What the experiment showed

| Run | Result |
|---|---|
| Empty DB + upstream migrations (reference) | 23 applied, 173 columns |
| **Copy of the live DB** + upstream migrations (candidate) | **exactly 7 applied**, 29 ledger rows, 186 columns |

The 7 that ran are precisely the ones missing by name: `wiring-threads-override`,
`container-config-timezone`, `approval-question-render-metadata`,
`messaging-group-detached-at`, `approvals-instance`, `host-coordination`,
`container-config-speed`. Nothing re-ran; nothing was skipped.

Schema diff, candidate vs reference:

- **Missing from candidate: nothing.** All 173 upstream columns present — no upstream
  migration was silently skipped, which was the feared failure.
- **Extra in candidate: exactly the fork's 13 columns** — `container_configs.env`,
  `.memory_budget_chars`, `.user_budget_chars`, `messaging_groups.reply_mode`, and the
  9-column `task_outcomes` table.

Data survived unchanged (agent_groups 15, messaging_groups 17, sessions 78, users 6,
user_roles 2, container_configs 15, messaging_group_agents 14, agent_destinations 13),
`pragma integrity_check` = ok, `pragma foreign_key_check` = no violations.

### 1.11.2 Consequences for stage 2

1. **No ledger surgery.** Point upstream code at the existing `data/v2.db` and it applies the
   7 it needs. No hand-stamping, no renumbering of existing rows.
2. **Migration `name` strings are load-bearing — do not "tidy" them.** A kept fork migration
   whose name still matches the ledger is correctly skipped on this install and still runs on
   a fresh one. Rename it and the live DB re-runs it, where
   `ALTER TABLE … ADD COLUMN reply_mode` fails on the already-present column. Names to
   preserve byte-for-byte: `reply-mode`, `reply-mode-channel-default`, `container-config-env`,
   `task-outcomes`.
3. **Dropped fork migrations leave inert residue.** `default-model-opus` and `memory-budgets`
   are being dropped (§1.5.5, §1.5.1), but their ledger rows and the
   `memory_budget_chars` / `user_budget_chars` columns stay in the live DB. Harmless —
   unreferenced columns with defaults. Cleaning them up is optional and needs a table
   recreate, so not worth it.
4. **`onlyBuiltDependencies` differs from the fork's.** Upstream lists `esbuild`,
   `protobufjs`, `sharp` — **not** `better-sqlite3`, which §6.6 claimed was identical to
   upstream. better-sqlite3 13.0.3 resolves from a prebuild and works without a build script
   (verified). Take upstream's list as-is; do not re-add better-sqlite3 without sign-off.

### 1.11.3 Clean-upstream baseline

`v2026.10.0` in an isolated worktree: `pnpm install --frozen-lockfile` + `pnpm run build`
clean, and **3559/3559 tests green**. One caveat: under this host's ambient `umask 002`, a
single `group-skills.test.ts` case fails because it hardcodes mode `644` while files land
`664`. Run the suite with `umask 022` — or treat that one failure as the known baseline.
Nothing in `materializeTemplateSkills` is actually broken.
