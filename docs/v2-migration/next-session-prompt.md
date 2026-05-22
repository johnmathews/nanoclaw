# Next-session prompt — NanoClaw v2 is live; migration is CLOSED

The v1 → v2 migration was declared complete on **2026-05-22** (see [`p3-notes.md` §22](p3-notes.md)). v2 is the canonical install at `/srv/apps/nanoclaw-v2/`; there's no more structured porting work to pick up.

The block below is the new handoff: a thin **regression-watch + deferred-items** prompt. Copy everything between the `---` lines into a new Claude Code session in `/srv/apps/nanoclaw-v2` whenever you next sit down with the project. It's self-contained — the new session won't see this file's surrounding context.

---

I'm working on NanoClaw v2 in regression-watch mode.

**State as of 2026-05-22:** the v1 → v2 migration is **CLOSED**. v2 is the canonical install at `/srv/apps/nanoclaw-v2`, running `nanoclaw-v2-787facac.service` (active + enabled, `Type=notify` + `WatchdogSec=30s`). v1 stays stopped + disabled at `/srv/apps/nanoclaw/` as a read-only tombstone (the journal mount references its path; do **not** `git pull` there). All 11 messaging groups are wired and routing: 9 Slack channels, 1 WhatsApp 1-on-1, 1 CLI. Image attachments arrive as Claude content blocks, voice attachments are Whisper-transcribed host-side, PDFs are extracted via pdftotext, reactions land as chat-sdk inbound + queryable via `mcp__nanoclaw__query_reactions`, Slack `send_blocks` works with the `ncv2:` action namespace. Working tree clean, everything pushed to `origin/main`.

**Required reading before doing anything load-bearing** (all paths inside `/srv/apps/nanoclaw-v2`):

    docs/v2-migration/p3-notes.md              §22 = closure record + deferred items + regression-
                                               watch protocol. §21 = Mon 2026-05-25 02:03 CEST
                                               (= 00:03 UTC) live-fire plan for §18's git-
                                               maintenance cron, currently the only outstanding
                                               verification.
    docs/v2-migration/fork-local-inventory.md  §"Closure summary" table is the canonical place to
                                               check whether a v1 file was ported, retired, or
                                               deferred. Every v1 file is preserved on the
                                               v1-archive branch.
    docs/v2-migration/operational-gotchas.md   Durable runtime knowledge — service paths, build
                                               steps, git topology, provider/multimodal/reactions
                                               wiring, Slack interactivity, scheduled tasks.
                                               Append new gotchas here; reference numbers stable.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-22; its description line carries the closure summary.

## Git topology

```
johnmathews/nanoclaw          ← all fork work, all current commits pushed
├── main                       ← tracking origin/main (canonical v2)
├── v1-archive                 ← v1 frozen at 0bd42bb (every retired file recoverable here)
└── v1-final-2026-05-22 (tag)  ← annotated tag on 0bd42bb

On /srv/apps/nanoclaw-v2 (canonical working tree):
  origin    → https://github.com/johnmathews/nanoclaw.git  (default push target for main)
  upstream  → https://github.com/nanocoai/nanoclaw.git     (read-only — fetch upstream NanoClaw updates)

On /srv/apps/nanoclaw (v1 tombstone — DO NOT `git pull` here):
  origin    → https://github.com/johnmathews/nanoclaw.git
  Local main still = 0bd42bb (diverges from remote main).
  Leave intact while journal mount uses /srv/apps/nanoclaw/journal/.
```

## What kind of session is this?

Pick the matching playbook:

### A. Live-verify §18's git-maintenance cron (Mon 2026-05-25 ≥ 02:10 CEST)

The cron `task-1775472071448-rpvh6c` is scheduled `3 2 * * 1,4` (interpreted in `Europe/Amsterdam`); next fire `2026-05-25T00:03:00Z = 02:03 CEST`. The Block Kit report sits in `#git-maintenance` until someone interacts.

1. Open `#git-maintenance`. Confirm the card rendered.
2. Verify action ids start with `ncv2:` (NOT `nanoclaw_*` — that's failure mode A in §21.2).
3. Optionally toggle 1–2 checkboxes, then click "Confirm Delete". The agent should act on the persisted list.
4. Log the outcome in `p3-notes.md` §22.3 (template already in the doc).

Failure-mode debugging guide is in `p3-notes.md` §21.2; sanity-check snippets in §21.3.

### B. A regression in production usage

1. Tail `logs/nanoclaw.log` + `logs/nanoclaw.error.log` (durable, structured — not journald).
2. `curl http://127.0.0.1:3002/health` for the channel + queue + scheduled-task snapshot.
3. If a specific session went silent: bisect via `data/v2-sessions/<agent-group>/<session>/inbound.db` (host wrote?) → `outbound.db` (container replied?).
4. If you need to compare against v1 behaviour: `git show v1-archive:src/<file>.ts` to read the v1 source (every fork-local file is preserved there).
5. Log the incident as a new top-level `## §N` in `p3-notes.md`. That document remains the single source of truth for v1→v2 history.

### C. You want to reopen a deferred item

The deferred-items table is in `p3-notes.md` §22.2 (operator-facing) and `fork-local-inventory.md` §"Closure summary" (per-file). Current contents:

- **W4.6 remote-control** — ad-hoc `claude.ai/code` URL capture; recover from `v1-archive:src/remote-control.ts` (224 LOC).
- **W4.2 status-tracker** — progress-emoji reactions for non-native-typing channels. Reopen only if you wire a channel without native typing (Discord, Matrix, …).
- **W5.1 Slack `getThreadMessages()` / migration v6 / `thread_ts` capture** — not retained; reopen only if a v2 caller actually needs them.
- **W5.3 Gmail channel** — `/add-gmail` skill; credentials NOT auto-migrated from v1.
- **§20 `skipImageMultimodal` host-side wiring** — per-attachment contract exists in `container/agent-runner/src/multimodal.ts` + tests; needs ~30 min to wire the host stamp from group config.

When you reopen one: edit the row in `fork-local-inventory.md` in place + add a new `## §N` to `p3-notes.md`. Don't extend `implementation-plan.md` — that document is frozen at closure.

### D. New feature work (not regression, not deferred-item reopen)

Migration docs are frozen. New work lives in PR descriptions, `journal/`, or new top-level docs in `docs/`. Treat the project as a normal production codebase — `CLAUDE.md` at the root is the authoritative entry point.

## Operational gotchas

**Read `docs/v2-migration/operational-gotchas.md`** — durable runtime notes (service paths, build steps, git topology, provider/multimodal/reactions wiring, Slack interactivity, scheduled tasks). Append new gotchas to that file; reference numbers are stable. Highlights:

- Canonical working tree: `/srv/apps/nanoclaw-v2`.
- v2 runs from `dist/`, not `src/`. `pnpm run build` is mandatory between any host-source edit and `systemctl --user restart nanoclaw-v2-787facac.service`.
- v2 logs: `logs/nanoclaw.{log,error.log}` (not journald).
- `/health` reachable at `127.0.0.1:3002`. After restart, sleep ≥ 6s before curling.
- OneCLI gateway on `127.0.0.1:10255`; web UI on `127.0.0.1:10254`.
- Git author identity workaround: no `user.name`/`user.email` set anywhere visible. Use `git -c user.name="John Mathews" -c user.email="mthwsjc@gmail.com" commit ...` per-command override.
- `main` tracks `origin/main`. Bare `git push` goes to the fork; `git fetch upstream` still works.
- v1-archive branch is load-bearing for recovery and audit lookups.

## What to deliver this session

- Whatever the session is about (regression fix / deferred-item reopen / new feature / §18 live-verify).
- Tests pass: `cd /srv/apps/nanoclaw-v2 && pnpm test` (baseline 39 files / 465 tests) + `cd container/agent-runner && bun test` (baseline 10 files / 118 tests).
- v2 healthy after any service-touching change: `curl http://127.0.0.1:3002/health` returns 200.
- New runtime gotchas appended to `docs/v2-migration/operational-gotchas.md`.
- New incidents added as `## §N` entries in `p3-notes.md`.
- `git push origin main` at end of session.
- Refresh this file **only** if the workflow/contract changes (e.g. a new deferred-item gets reopened-and-deferred-again, or v2's runtime baseline shifts). Don't churn it for routine session handoff — there's no work-unit picker anymore.
