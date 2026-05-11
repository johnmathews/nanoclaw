---
date: 2026-05-11
tags: [docs, decision]
---

# Docs Sweep — Drift Fixes, New References, and Deferred Items

Second-pass sweep across all human-facing documentation. The first sweep (see
[260511-docs-overhaul.md](260511-docs-overhaul.md)) deleted aspirational docs and refreshed core references; this
one verified every concrete claim against current code, fixed the drift, and added two missing reference docs
(`docs/slash-commands.md` and `docs/fork-divergence.md`). Test suite stayed green throughout — final count 786
(was 785; +1 for the new security-flag test).

## What changed

Worked from a structured plan in `.engineering-team/improvement-plan.md`, which itself was driven by an evaluation
report in `.engineering-team/evaluation-report.md`. Both files are intermediate artifacts; the work units
(`WU1`–`WU13`) below correspond to the plan.

### Drift fixes

- **`.env.example` (WU1):** Added `CONTAINER_MAX_OUTPUT_SIZE`, `MAX_MESSAGES_PER_PROMPT`, `IDLE_TIMEOUT`,
  `GITHUB_TOKEN`, `LOG_LEVEL`, `TZ`. Header now points at `docs/SPEC.md §15` as the full reference.
- **Container-side session path (WU2):** Corrected `/workspace/group/.claude` → `/home/node/.claude` in `SPEC.md`
  (§6 mounts table and §9 prose). The host-side path under `data/sessions/<group>/.claude/` was already correct.
  `SDK_DEEP_DIVE.md` didn't contain the wrong path on recheck — earlier audit was approximate.
- **`CLAUDE.md` (WU3a + WU3b):** Refreshed the key-files table (added `credential-proxy.ts`, `container-runtime.ts`,
  `mount-security.ts`, `sender-allowlist.ts`, `status-tracker.ts`, `message-loop.ts`, `session-cleanup.ts`; fixed
  the `agent-browser` SKILL.md path). Replaced the WhatsApp "separate fork" troubleshooting blurb — WhatsApp is
  bundled in *this* fork's `main`; upstream is the one that separates it. Corrected the agent-runner mount
  description: TypeScript is **not** recompiled at runtime (the entrypoint runs prebuilt `dist/`), so source
  changes need `./container/build.sh`. Re-pointed Slack thread/typing sections at `docs/slack-attachments.md`
  rather than duplicating them inline. Added the in-container `nanoclaw` MCP server section (was previously
  documented only in `SPEC.md`). Softened the "all channels have native indicators" claim — Gmail doesn't declare
  `hasNativeTyping`. Linked `docs/index.md` from the header so the source-of-truth ordering is discoverable.
- **`SPEC.md` (WU4):** Removed `OPENAI_API_KEY` from the container env list (it's host-side only for transcription);
  collapsed `status_tracker_state` table row into the `router_state` row (the dedicated table doesn't exist —
  StatusTracker state goes into the KV); softened the "isMain and requiresTrigger preserved across re-registration"
  claim because an explicit value in the re-register payload still wins for `requiresTrigger`; updated the WhatsApp
  row of the channels table to reflect this fork's bundled state.
- **`README.md` (WU5):** Resolved the Linux contradiction (the FAQ correctly says Linux works; the Docker Sandboxes
  callout no longer says "Linux support coming soon"). Reworded the channels paragraph to acknowledge Discord is
  a skill, not a bundled channel. Added a "Verify your install" section after `/setup` with concrete commands. Added
  inbound links to `docs/index.md` and `docs/slash-commands.md`.
- **`REQUIREMENTS.md` (WU6):** Same WhatsApp/Discord corrections. Clarified that `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
  is set unconditionally by the agent-runner, not a configurable default.
- **`credential-proxy.md` (WU6):** Noted in §6.4 that `detectProxyBindHost()` lives in `container-runtime.ts`,
  not `credential-proxy.ts`.
- **`skills-as-branches.md` (WU7):** Added `telegram` and `discord` rows to the channel-skills table and a
  "bundled vs upstream" notes column. Linked `fork-divergence.md`.
- **Filename rename (WU8):** `docs/SLACK-ATTACHMENTS.md` → `docs/slack-attachments.md` (matching the lowercase-
  with-hyphens convention used by the newer docs). Inbound links updated in `docs/index.md`, `SPEC.md`, and the
  two journal entries that referenced the old name.
- **`CONTRIBUTING.md` (WU10):** Added a "Skill branches and the rebase rule" section pointing at
  `docs/skills-as-branches.md` and explaining the CI-enforced rebase-onto-main rule. Test guidance also clarified.
- **`repo-tokens/README.md` (WU10):** `qwibitai/NanoClaw` → `qwibitai/nanoclaw` (repo name uses lowercase).

### New reference docs

- **`docs/slash-commands.md` (WU11):** Canonical reference for every slash command — `/usage`, `/status`, `/skills`,
  `/clear`, `/model`, `/compact`, `/done` — with the host/agent-runner/SDK split, auth model, file:line citations,
  and per-command notes. Surfaced surprises: `/model` is hybrid (runs an SDK init query then intercepts), and the
  auth bypass for read-only commands is enforced in two places (`src/index.ts:797` and `src/session-commands.ts:119`)
  that must stay in sync. README and CLAUDE.md now link to it instead of duplicating partial tables.
- **`docs/fork-divergence.md` (WU12):** Single index of features this fork ships on top of upstream
  `qwibitai/nanoclaw` — credential proxy, journal MCP wiring, sender allowlist, mount security, bundled WhatsApp,
  Discord-skill-only, status tracker. Each entry names the code that implements it and links the canonical doc.
  Referenced from `README.md`, `CLAUDE.md`, `docs/index.md`, `skills-as-branches.md`, `REQUIREMENTS.md`, and `SPEC.md`.

### One code change

- **`src/container-runner.ts` (WU9):** Added `--security-opt no-new-privileges` to the docker run args so the
  hardening claim in `docs/SECURITY.md` §1 is actually enforced. Added a test in `src/container-runner.test.ts`
  modeled on the existing `--memory`/`--cpus` test. 786/786 tests pass.

## Deferred items

Items surfaced by the sweep but deliberately not addressed here:

1. **Systemd unit `Type=notify` fix.** `setup/service.ts:241` currently writes `Type=simple` with no
   `NotifyAccess` or `WatchdogSec` directives. As a result, `initWatchdog()` returns `null` (`NOTIFY_SOCKET`
   is unset in the service environment) and the documented health-monitoring layer 3 — described in `CLAUDE.md`
   and `SPEC.md §17` as a 30s watchdog with 15-miss restart — is silently disabled by the installer. Fix is a
   small edit in `setup/service.ts`; risk is medium because it changes restart semantics for any existing user
   who reinstalls. Open as a separate work item; the doc text remains aspirational until the installer matches.

2. **`CHANGELOG.md` decision.** The file has one entry (v1.2.0) for a project at v1.2.70. Either revive (and
   wire into the version-bump workflow that touches `package.json`) or retire (delete the file and update the
   README link). Either way the current half-life is the worst of both.

3. **`CLAUDE.md` structural split.** Doing too many jobs at once (agent instructions + developer overview + ops
   reference + troubleshooting). This sweep trimmed duplicated content and added cross-references; a proper split
   into a thin agent-instruction file plus moving content into canonical homes is a separate refactor.

4. **README token-count badge alt-text staleness.** Badge SVG and alt-text say "91.8k tokens · 46% of context
   window"; the latest commit bumped to "93.1k tokens · 47%". The auto-update workflow refreshes the SVG but not
   the surrounding HTML alt-text. Workflow fix, not a doc fix.

5. **Older doc filename migration.** `REQUIREMENTS.md`, `SPEC.md`, `SECURITY.md`, `SDK_DEEP_DIVE.md` kept their
   uppercase names because they're heavily cross-referenced. Migrating them to lowercase-with-hyphens (matching
   the newer docs) is a low-risk batch rename plus inbound-link sweep — saved for a future pass.

6. **GHCR container publishing — deliberately not set up.** The `/done` skill's blanket rule says any repo with a
   `Dockerfile` should publish to `ghcr.io/johnmathews/<repo>`. Skipped here because the project's design is
   per-user forks (each user runs `./container/build.sh` locally to bake in their own customizations). Publishing
   this fork's container image to a public registry would broadcast fork-local features (credential proxy,
   sender allowlist, journal MCP wiring) as a "canonical" image, which contradicts the fork-per-user model. The
   existing `ci.yml` workflow handles typecheck/format/build/tests/schema-version/skill-rebase checks, which is
   the right CI surface for this project.

## Process notes

The structured "evaluate → plan → develop" flow (with explicit user-gate before Phase 3) was the right pattern for
a sweep of this size. The plan document caught two items that would have caused rework if I'd jumped straight to
edits: the systemd `Type=notify` finding (whose fix isn't a docs change) and the question of whether to ship new
docs in this pass or defer them. Resolving those at planning time saved a Phase-3 rewrite cycle.

Worktree was useful here: 14 work units across 12 files plus 1 code change is exactly the size where keeping `main`
clean while iterating matters. The sweep is being delivered as a single squash-friendly branch.
