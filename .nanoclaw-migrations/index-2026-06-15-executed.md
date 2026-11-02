# NanoClaw Migration Guide

Generated: 2026-06-15
Base (merge-base where fork diverged): `2492259` (2026-05-25)
HEAD at generation: `971239a`
Upstream at generation: `acbb114`

This guide lets a fresh Claude session reproduce this fork's customizations on a
**clean upstream checkout** (intent-based migration, not merge). It was extracted
by `/migrate-nanoclaw` Phase 1. The upgrade (Phase 2) has **not** been run yet.

## Operator decisions (locked 2026-06-15)

1. **Channel-instance / multi-instance dimension → ACCEPT DORMANT.** Upstream has
   re-introduced the instance dimension this fork removed. Do **not** re-remove it.
   Build on clean upstream as-is; the instance column/routing stays present but
   unused (opt-in via config). All fork customizations layer on top of upstream's
   current schema. Where a fork commit removed instance code (e.g. `reply_mode`
   migrations replaced `016-messaging-group-instance.ts`, router/delivery dropped
   `instance` args), **re-apply only the fork's net feature** (reply_mode, etc.) on
   top of upstream's instance-aware code — do not delete upstream's instance logic.

2. **OneCLI SDK → TARGET 2.2.1 + gateway upgrade.** Clean upstream is on
   `@onecli-sh/sdk` 2.2.1 (BREAKING vs the fork's 0.5.0). Keep upstream's 2.2.1 and
   perform the OneCLI gateway upgrade per `docs/onecli-upgrades.md` during Phase 2.
   Do **not** pin back to 0.5.0.

## Migration plan (order of operations)

Phase 2 should proceed in this order; validate (`pnpm run build && pnpm test`) after
each numbered stage:

1. **DB schema & migrations first** — renumber fork migrations 016–021 to the next
   free numbers after whatever upstream/main now has in `src/db/migrations/`, then
   register them. See `01-learning-and-memory.md` and `05-health-ops-and-defaults.md`.
   (Migration numbering is the single biggest collision risk — do this carefully.)
2. **Host-side standalone modules** — copy new files that have no upstream conflict:
   `src/db/search-index-db.ts`, `src/db/task-outcomes.ts`, `src/search-index.ts`,
   `src/pdf-extract.ts`, `src/transcription.ts`, `src/onecli-identifier.ts`,
   `src/usage.ts`, `src/health*.ts`, `src/watchdog.ts`, `src/modules/memory/*`,
   `src/modules/search/*`.
3. **Host-side edits to upstream files** — `container-config.ts`, `container-runner.ts`,
   `claude-md-compose.ts`, `command-gate.ts`, `router.ts`, `delivery.ts`,
   `host-sweep.ts`, `index.ts`, `db/container-configs.ts`, `db/messaging-groups.ts`,
   `types.ts`, `cli/*`, `modules/index.ts`, `modules/approvals/onecli-approvals.ts`,
   `modules/agent-to-agent/create-agent.ts`. **High merge-risk files:** `index.ts`,
   `container-runner.ts`, `host-sweep.ts` (upstream refactored these heavily — read
   the upstream version before editing).
4. **Channels** — run `/add-whatsapp`, `/add-slack`, `/add-resend` (in that order),
   then re-apply the fork's per-channel modifications. See `02-channels.md`.
5. **Container agent-runner** — new MCP tools + edits. See
   `03-multimodal-and-reactions.md` and `01-learning-and-memory.md` (container side).
   Run `cd container/agent-runner && bun install` then
   `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.
6. **Container build surface** — Dockerfile (Gmail/GCal MCPs), container skills. See
   `04-container-env-and-build.md`.
7. **Config & misc** — `04`/`06` section files (Dockerfile, .gitignore, husky, etc.).
8. **OneCLI gateway upgrade** — per decision #2 and `docs/onecli-upgrades.md`.
9. **Validate + live round-trip** — build, test, container build, then post into
   `#nanoclaw-introspection` (Slack `C0AMETJFW9X`) and confirm a reply lands.

## Round-trip tool architecture (read before porting memory/search)

`remember` and `search_history` are **host↔container round-trip** tools, not direct
DB writers. The container can't write group source files or open the host index DB,
so: container MCP tool writes a `system` action row to `outbound.db` → host delivery
layer handles the action, applies the change, writes a deterministically-named reply
(`rem-resp-<id>` / `search-resp-<id>`) into `inbound.db` with `trigger=0` (no re-wake)
→ container polls `findResponseById` until it arrives. **Both halves must be ported or
the tool times out after 30s.** See `01-learning-and-memory.md`.

## Table of contents

- `01-learning-and-memory.md` — remember, search_history, task-outcomes, FTS5 index,
  MEMORY.md/USER.md compose, learn-skill, reporting skill, migrations 020/021.
- `02-channels.md` — Slack/WhatsApp/Resend re-install + modifications, chat-sdk-bridge.
- `03-multimodal-and-reactions.md` — image/voice/PDF, query_reactions, host pdf/whisper.
- `04-container-env-and-build.md` — per-group env (migration 019), Dockerfile, skills.
- `05-health-ops-and-defaults.md` — health/watchdog, /status, /usage, reply_mode,
  default model (017), onecli-identifier, migrations 016/017/018.
- `06-infra-fixes-and-config.md` — internal-tag strip, symlink shadow fix, install-slug,
  mount-security tests, update-nanoclaw opt-out, package.json, config files, PG scripts.

## DO NOT PORT (install-specific one-offs / already-applied data migrations)

These contain hardcoded IDs for THIS deployment or are one-shot migrations already run:

- `scripts/ft-kickoff.ts` — one-off `#financial-times` trigger, hardcoded channel/sender IDs.
- `scripts/init-ft-channel.ts` — one-off `#financial-times` bootstrap. Use `/manage-channels`.
- `scripts/close-non-winner-sessions.ts` — one-shot session cleanup, hardcoded IDs. Already applied.
- `scripts/externalize-task-prompts.ts` — one-shot task-prompt migration, hardcoded IDs. Already applied.
- `scripts/setup-ritsya-job-search.ts` — one-off agent-group create, hardcoded IDs. Use `/manage-channels`.
- `groups/**`, `data/**`, `store/**`, `.env`, `journal/**` — install data/content, never ported by this skill.
- `.claude/settings.json` `Bash(gh run watch *)` — local convenience permission; port only if wanted.

## SKIP (upstream already has these — verified empty `git diff upstream/main..HEAD`)

- Host-sweep `justWoke` grace period (`0743a88`) + `host-sweep-grace.test.ts`.
- `create_agent` host-side authorization core + `index.ts` registration (`58e018f`); only a
  small provider-inheritance-removal delta remains fork-side (see `02`/`05` notes — and note
  per decision #1 we generally keep upstream behavior, so this delta is OPTIONAL).
- `container/agent-runner/src/mcp-tools/agents.ts` (identical to upstream).
- `writeOutboundDirect` rw fix — upstream has `eef285b`; fork has equivalent `d8c04b8`. No port needed.
- pnpm-workspace.yaml supply-chain policy — identical to upstream; **preserve verbatim, never loosen**.

## Verification checklist (per-feature, when reapplying)

After Phase 2, confirm: every new module is registered in its barrel (`src/modules/index.ts`,
`container/agent-runner/src/mcp-tools/index.ts`); migrations run cleanly on a fresh DB; host
build + `pnpm test` green; container typecheck + `bun test` green; container image builds;
live `#nanoclaw-introspection` round-trip returns a reply.
