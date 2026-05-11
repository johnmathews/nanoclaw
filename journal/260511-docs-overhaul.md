---
tags: [docs, decision]
---

# /docs/ Overhaul: Delete the Aspirational, Refresh the Real

Date: 2026-05-11

The user announced they were going to start relying on `/docs/` much more, and asked me to improve quality, scan
for stale links, and verify claims against the code. I ran a parallel audit across all 12 doc files (clustered by
topic) before making any edits. Outcomes by file below; bigger-picture observations at the end.

## What changed

### Deleted (4 files)

| File                                  | Why                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `nanoclaw-architecture-final.md` (44k) | Design spec for a `.nanoclaw/` skill-package system that was never built. Every concept (manifest.yaml, intent files, rerere-cached three-way merge, `.nanoclaw/state.yaml`) is absent from the codebase. |
| `nanorepo-architecture.md` (10k)      | Abridged copy of the same abandoned design.                                          |
| `APPLE-CONTAINER-NETWORKING.md` (3k)  | macOS-specific networking guide for a runtime not used in this install (Docker on Linux/Proxmox). The `convert-to-apple-container` skill owns the Apple Container story. |
| `DEBUG_CHECKLIST.md` (5k)             | Symptom-based debugging notes ~80% covered (and better) by `runbooks/troubleshooting.md`. The two unique sections (session-transcript branching investigation, container log file pattern) were folded into the runbook. The doc's "known issues" from 2026-02-08 had all been silently fixed (cursor restoration on failure at `index.ts:510`, grace-period timeout at `container-runner.ts:552-554`). |

### Substantially rewritten (3 files)

| File                       | Before                                            | After                                                                  |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `SPEC.md`                  | 643 lines, ~40% wrong/missing per the audit       | 480 lines, freshly written from `CLAUDE.md` + `runbooks/architecture-overview.md` + `src/types.ts` + `src/config.ts`. SDK version bumped (0.2.92), credential-proxy story replaces the obsolete `data/env/env` mount fiction, all current MCP servers + Slack threads + reactions + image pipeline + voice + per-group config + health monitoring + sender allowlist documented. |
| `docker-sandboxes.md`      | Conflated Docker Sandbox MITM with NanoClaw's credential proxy; used `scripts/apply-skill.ts` (deleted); ignored Apple Container; assumed API key (no OAuth) | Disambiguated the two proxies up front; added an "On macOS, prefer Apple Container" steer; replaced apply-skill.ts with the current git-remote-based install pattern; mentioned OAuth-mode placeholder. Patches were verified still-absent from upstream (so the doc's framing as "you must add these" remains correct). |
| `skills-as-branches.md`    | 28k describing an aspirational `nanoclaw-skills` plugin marketplace that was never deployed, and a `git merge upstream/skill/*` model that contradicts the rebase-onto-main rule in CLAUDE.md | ~150 lines describing the actual two-model reality: skill branches on upstream + channel skills as separate remotes (`whatsapp`, `slack`, `gmail`); the rebase-onto-main rule and CI gates; explicit "Anti-Patterns Avoided" list naming the marketplace, manifest files, rerere caching, and apply-skill.ts as deliberately not used. |

### Targeted fixes (4 files)

| File                       | Key changes                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SECURITY.md`              | Honest framing of credential proxy ("long-lived credentials never enter container" vs the previous overstated "agents cannot discover real credentials"); added Apple Container; mount allowlist JSON shape; resource limits as security boundary; `PROXY_BIND_HOST` per-runtime behavior; flagged that always-on MCP credential mounts (Gmail, Calendar) cross into non-main groups. |
| `REQUIREMENTS.md`          | Added direct-conversation groups (`requiresTrigger=false`); flagged WhatsApp as a separate fork; added the full current skill inventory; noted Linux/systemd; added all post-April features (proxy, monitoring, image, voice, threads, per-group config, sender allowlist). |
| `SLACK-ATTACHMENTS.md`     | Corrected host-side image lifecycle (immediate-delete after base64 load, not "at start of each container invocation"); added PDF special case (`pdf-reader extract`); thread support section; image vision + `skipImageMultimodal`; `:eyes:` reaction lifecycle; `MAX_MESSAGE_LENGTH=4000` chunking; full required OAuth scope list including `reactions:write`; cross-refs to the relevant journal entries. |
| `SDK_DEEP_DIVE.md`         | Updated version banner (0.2.92 vs the original 0.2.29-0.2.34); added a "How NanoClaw uses the SDK" call-site table at the top with concrete line numbers in `container/agent-runner/src/index.ts`; flagged the minified-identifier table as historical (almost certainly renamed in current bundles). |

### New (2 files)

| File                                              | Purpose                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `journal/260511-add-credential-proxy-oauth.md`    | Decision record for the credential proxy: motivation, design, three known limitations (token-freshness drift, full-body buffering, no proxy health check), fork-local flag for `/update-nanoclaw`. |
| `docs/credential-proxy.md` (713 lines)            | Detailed reference doc written for other agents to use as a model when building similar credential-injection layers. Covers wire-level request flow for both auth modes; implementation walkthrough; strengths (6); weaknesses (10); how to improve (8 prioritized items with code snippets); generalizable principles for porting the pattern to other SDKs (10 items); alternatives considered. |

### Index restructured

`docs/index.md` rewritten as a proper TOC grouped by purpose: Architecture & Reference, Operations & Runbooks
(linking out to `/runbooks/`), Decision Journal (linking to `/journal/`). Added an "Authority" section listing
the order of precedence when sources disagree (code → CLAUDE.md → runbooks → docs → journal).

### Runbook fold

Bits of `DEBUG_CHECKLIST.md` worth keeping moved into `runbooks/troubleshooting.md`:

- **Session Transcript Branching** investigation script (the parentUuid walker)
- **Container Logs** section (per-group log path pattern)
- Replaced the runbook's two `sqlite3` CLI invocations with `node + better-sqlite3` (per `feedback_db_access.md`
  — there's no `sqlite3` CLI on this host).

## How the audit worked

I spawned four parallel agents covering doc clusters (architecture, security, SDK/skills, ops). Each was told to
verify against current code and produce a per-file verdict (KEEP / TARGETED_FIXES / SUBSTANTIAL_REWRITE /
DELETE_OR_FOLD), with line-number-specific evidence. That made the next step (asking the user about deletion
decisions) quick — a single `AskUserQuestion` with four pre-shaped options, picking a strategy.

The user picked the most aggressive cleanup: delete the four clearly-dead docs, rewrite the two SUBSTANTIAL ones,
make targeted fixes everywhere else.

## Why the docs had drifted

Pattern across the audit findings: **most stale docs were design-spec writeups for systems that turned out
differently in implementation.** `nanoclaw-architecture-final.md` planned an elaborate skill marketplace; the
project shipped git remotes instead. `skills-as-branches.md` sketched a `qwibitai/nanoclaw-skills` plugin; that
repo doesn't exist. `SDK_DEEP_DIVE.md` was a research doc against v0.2.34 that nobody updated when the SDK moved
60 patch versions.

Reference docs that described shipped features (`SECURITY.md`, `SLACK-ATTACHMENTS.md`) had aged better but still
needed updates because shipped features kept evolving (Slack threads, image vision, the credential proxy itself
all post-dated their original writing).

The runbooks (`/runbooks/`, dated 2026-04-07) were consistently the freshest documentation in the repo. They
became the model the older `/docs/` set was brought up to.

## Followups dropped

A few audit findings I noted but didn't act on this session:

- The `runbooks/troubleshooting.md` still uses `sqlite3 store/messages.db` in one of its DB-corruption snippets
  even after my fix — actually no, I did fix the `PRAGMA integrity_check` call. Confirmed.
- `docs/SDK_DEEP_DIVE.md` could use a deeper "current behavior" pass against `container/agent-runner/src/`
  beyond the call-site table I added at the top — but the existing prose mostly still applies conceptually.
- The credential proxy itself has the token-freshness bug documented in
  `journal/260511-add-credential-proxy-oauth.md` and `docs/credential-proxy.md §11.1` and §12.1 — still unfixed
  in code.

## Net change

```
9 files modified, 4 files deleted, 2 files added
-1809 lines, +1804 lines (the 713-line credential-proxy.md offsets the cleanup)
0 broken markdown links across the doc set
```
