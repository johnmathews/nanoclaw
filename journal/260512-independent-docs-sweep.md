---
date: 2026-05-12
tags: [docs, decision]
---

# Independent Documentation Sweep — Drift Catch + Structural Tightening

Second docs sweep in two days. The 2026-05-11 sweep ([260511-docs-sweep-and-deferred-items.md](260511-docs-sweep-and-deferred-items.md))
was thorough but the user asked for an independent re-audit treating that sweep as one data point rather than ground
truth. The audit was right to be independent — the previous sweep had introduced one fresh inaccuracy in `SPEC.md`
(StatusTracker state "in KV" — it's actually `data/status-tracker.json`) and missed several mid-impact drifts
in `SPEC.md` and `SECURITY.md`.

Four parallel subagents ran the eval: code-vs-doc accuracy, cross-doc coherence + gaps, LLM/agent legibility, and
completeness/audience fit. Reports synthesized into `.engineering-team/evaluation-report.md` and an improvement
plan of 17 work units. All 17 shipped in this commit. Tests stayed green throughout — 786/786 (no code changes).

## What changed

### Accuracy fixes (Critical)

- **`SPEC.md` drift cluster (WU1).** Telegram listed as `/add-telegram` skill → fixed to `src/channels/telegram.ts`
  (bundled in this fork). `/app/src` mount mode `ro` → `rw` (matches `src/container-runner.ts:264`).
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` moved out of the "set in container-runner.ts" list — it's set by
  `container/agent-runner/src/index.ts:592`, not by the host. nanoclaw MCP tool list bumped from 8 to 10
  (added `react_to_message` and `query_reactions`). StatusTracker state removed from the `router_state` row of §13
  (it's a JSON file, not a KV entry). `compact_boundary` vs `PreCompact` hook split into two sentences with
  distinct line citations. `src/index.ts:983` → `:984`. §16 directory layout updated to acknowledge bundled
  WhatsApp + Telegram alongside Slack + Gmail.
- **`SECURITY.md` §4 re-registration claim (WU2).** Previous wording said `isMain` and `requiresTrigger` are
  "preserved from the existing registration." Wrong as stated — `src/ipc.ts:551` uses
  `data.requiresTrigger ?? existing?.requiresTrigger`, so an explicit payload value overrides existing state.
  Only `isMain` is fully locked down (line 552 ignores payload). Doc now describes both behaviours separately.
  Also added `.gpg` and `.pypirc` to the blocked-pattern list, and a citation for `--security-opt no-new-privileges`
  enforcement (`src/container-runner.ts:347`).
- **`CLAUDE.md` and `slash-commands.md` `/usage` URL (WU3).** Both docs cited `console.anthropic.com/.../oauth/usage`.
  Reality: the usage endpoint is `api.anthropic.com/api/oauth/usage` (`src/host-commands.ts:230`);
  `console.anthropic.com` is the token-refresh endpoint (`host-commands.ts:92`). Fixed in both places.

### README onboarding fixes (High)

- **Fork banner (WU4).** README now opens with an explicit "this is a fork of qwibitai/nanoclaw with fork-local
  features" banner linking `docs/fork-divergence.md`. Closes the trap where a user landing on this fork's GitHub
  page and following the Quick Start would silently end up on upstream.
- **Quick Start fork target.** `gh repo fork qwibitai/nanoclaw` → `gh repo fork johnmathews/nanoclaw`. Anyone
  wanting upstream is still pointed at it explicitly in the surrounding prose.
- **"Container isolation" line.** Now clarifies default (Docker) vs. optional (Apple Container, Docker Sandboxes).
- **"What It Supports."** Dropped the contradictory `/add-gmail` second mention of Gmail — Gmail is bundled.
- **`CHANGELOG.md` retired (WU13).** Deleted; README "Changelog" section removed. The file had one v1.2.0 entry on
  a v1.2.71 project; git history is the changelog for this project model.

### CLAUDE.md restructure (High, partial-restructure not full split)

- **Task-routing header at the top.** 8-row "If you're about to X, look here first" table covering the most common
  task types — adding a channel, touching the DB, modifying credential flow, slash commands, mounts, session state,
  debugging, re-auth, pulling upstream.
- **Key Files table grouped under sub-headings** (Entry point / Channels / Containers / IPC,scheduling,session /
  Security boundary / Health / Storage). Added rows for previously-omitted files: `src/group-queue.ts`,
  `src/env.ts`, `src/logger.ts`, `src/remote-control.ts`, `data/status-tracker.json`, `data/remote-control.json`.
- **New sections:** Reliability / Sturdiness, Testing, Load-bearing files, Logs, Database access, Troubleshooting
  pointer, Channel Typing Indicators (now a pointer to the canonical doc).
- **Deep content moved to SPEC.md / pointered:** Image Attachment Pipeline (still summarized here, full version in
  SPEC §6); Health Monitoring kept (it's load-bearing) plus a known-installer-gap caveat about `Type=notify`.
- **Inlined model IDs → pointer.** `opus`/`sonnet`/`haiku` aliases kept; model IDs removed in favour of
  "see `DEFAULT_MODEL_ALIASES` and `DEFAULT_MODEL` in `src/group-config.ts`".
- **`\usage` → `/usage`.** Cosmetic but consistent.
- **"Linux VMs" parenthetical removed** — containers aren't VMs on default Linux Docker.
- **Sender allowlist:** "per-channel" → "per-chat" (allowlist keys by `chatJid`).
- **Containerized config example:** added a concrete `containerConfig.additionalMounts` payload so per-group
  customisation is self-explanatory.

### New: re-auth runbook (WU16 — user added to scope after eval)

`runbooks/re-auth.md` — symptom-keyed playbook for WhatsApp, Gmail, Google Calendar, and Slack re-auth flows.
Covers the WhatsApp pairing-code procedure with the crash-loop → 405 rate-limit gotcha; Gmail and Calendar OAuth
re-auth with the SSH-tunnel requirement for headless servers; Slack re-auth via re-running the `/add-slack` skill.
Linked from `CLAUDE.md` task-routing table and `docs/index.md` runbooks listing.

### Source-of-truth ordering tightening

- **`docs/index.md` Authority section** now lists topic-canonical exceptions explicitly — `slash-commands.md`,
  `slack-attachments.md` (including channel typing indicators), `credential-proxy.md`,
  `fork-divergence.md` (including sender allowlist). The five-tier ordering held but didn't acknowledge
  topic-level canonical claims, so docs were silently in disagreement at exactly the decision points the ordering
  was meant to resolve.
- **`slack-attachments.md`** "Working-Indicator Reactions" section renamed and rewritten as a channel-agnostic
  "Channel Typing Indicators" canonical reference; CLAUDE.md / SPEC.md / fork-divergence.md updated to point at
  it instead of restating it three different ways.
- **`fork-divergence.md` Sender Allowlist section** promoted to the canonical reference for that feature, with
  file format + semantics + motivation broken out explicitly. REQUIREMENTS/SECURITY/SPEC now point at it.

### Smaller fixes

- `credential-proxy.md`: new TL;DR cheat-sheet at top; broken §15.1 reference fixed (points at §11.1 and §13.7);
  `getValidAccessToken` import example clarified (function is currently private; would need export-first).
- `CONTRIBUTING.md`: rewritten with house-style section (commit conventions, branch, format, build+test, tests
  required), fixed broken "Maintaining a Skill Branch" anchor, added one-line GHCR-skipped explainer, fixed
  `/add-telegram` example path to `.claude/skills/add-telegram/SKILL.md`.
- `REQUIREMENTS.md`: added a "Sturdiness" item to Philosophy capturing the user's stated top design priority;
  added "code wins" preamble; renamed "Vision" → "Current Architecture" so MCP integrations don't read as
  aspirational; labelled RFS rows "(not yet built)"; acknowledged the pipe-to-running-container path in §Container
  Isolation.
- `SPEC.md`: added a Host-vs-Container table to §1 (no central "what runs where" map existed before); added env-var
  unit annotations (`(ms)`, `(bytes)`, `(cores)`); fixed the `IDLE_TIMEOUT + 30s` mixed-unit slip; named the daily
  session-cleanup script and interval.
- `SDK_DEEP_DIVE.md`: `SdkBeta = 'context-1m-2025-08-07'` annotated with a "verify against the SDK type file"
  caveat.
- `docs/index.md`: documented the uppercase-canonical / lowercase-topical filename convention as intentional, not
  pending migration.

## Disagreements with the previous sweep (resolved here)

1. **CHANGELOG**: prior sweep "decide later". Retired now.
2. **Uppercase filename migration**: prior sweep "saved for a future pass". Dropped entirely — the case-as-signal
   convention is documented in `docs/index.md`.
3. **CLAUDE.md structural split**: prior sweep "a separate refactor". Did a partial restructure (task-routing
   header + content grouping + canonical pointers) without changing file boundaries; net effect is that CLAUDE.md
   stays in the same place but is faster for an agent to navigate.

## Deferred (still outstanding)

1. **systemd `Type=notify` installer fix** (`setup/service.ts:241`). Code change, not a docs fix. Doc caveats
   added to `CLAUDE.md §Health Monitoring` and `SPEC.md §14` so anyone reading either knows the watchdog is
   silently disabled on fresh installs.
2. **README token-count badge alt-text staleness.** Workflow fix in the badge auto-update job.
3. **README_ja / README_zh translations.** Almost certainly stale relative to the new fork-banner / Quick Start
   changes. User excluded from scope.
4. **ESLint setup.** Project has only `prettier` + `tsc --noEmit`. Out of scope for a docs sweep.

## Process notes

The independent re-audit was the right call. Two of the highest-impact findings (the SPEC.md StatusTracker-in-KV
claim, the SECURITY.md `requiresTrigger` re-registration wording) were misses the previous sweep wouldn't have
caught because the previous sweep had verified against intermediate plan docs rather than re-grepping the code.
Re-running with code-grounded subagents and explicit cross-checking surfaced both within the first verification
pass.

The four-subagent split (accuracy / coherence / legibility / completeness) covered different failure modes
cleanly; only two findings overlapped between subagents (the Telegram-bundled-not-skill drift and the
StatusTracker-persistence-location issue both showed up in subagents 1 + 2, which actually strengthened
confidence since the verification paths were independent).

Worktree was useful again: 14 files modified + 1 new + 1 deleted is the size where keeping `main` clean while
iterating matters. The sweep ships as a single squash-friendly branch.
