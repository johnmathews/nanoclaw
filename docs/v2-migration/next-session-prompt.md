# Next-session prompt — NanoClaw v2 is live; migration is CLOSED

**Status:** live regression-watch handoff template. **Last updated:** 2026-05-28. **Path-renames since closure:** v1 install deleted, v2 renamed to `/srv/apps/nanoclaw` (see `journal/260525-remove-v1-and-drop-v2-suffix.md`); systemd unit dropped its `-v2-` infix and is now `nanoclaw-<install-slug>.service` (currently `nanoclaw-583cc1c4.service` for `/srv/apps/nanoclaw`).

The v1 → v2 migration was declared complete on **2026-05-22** (see [`p3-notes.md` §22](p3-notes.md)). v2 is the canonical install at `/srv/apps/nanoclaw/`; v1 has been deleted. The §18 live-verify gate closed without incident on 2026-05-28 (see [`p3-notes.md` §22.3](p3-notes.md)).

The block below is the new handoff: a thin **regression-watch + deferred-items** prompt. Copy everything between the `---` lines into a new Claude Code session in `/srv/apps/nanoclaw` whenever you next sit down with the project. It's self-contained — the new session won't see this file's surrounding context.

---

I'm working on NanoClaw v2 in regression-watch mode.

**State as of 2026-05-28:** the v1 → v2 migration is **CLOSED**. v2 is the canonical (and only) install at `/srv/apps/nanoclaw`, running `nanoclaw-<install-slug>.service` (active + enabled, `Type=notify` + `WatchdogSec=30s`). v1 has been deleted; the only surviving v1 artefact is the `v1-archive` git branch on the fork, which preserves every fork-local v1 file for recovery / audit. All 11 messaging groups are wired and routing: 9 Slack channels, 1 WhatsApp 1-on-1, 1 CLI. Image attachments arrive as Claude content blocks, voice attachments are Whisper-transcribed host-side, PDFs are extracted via pdftotext, reactions land as chat-sdk inbound + queryable via `mcp__nanoclaw__query_reactions`, Slack `send_blocks` works with the `ncv2:` action namespace. Working tree clean, everything pushed to `origin/main`.

**Required reading before doing anything load-bearing** (all paths inside `/srv/apps/nanoclaw`):

    docs/v2-migration/p3-notes.md              §22 = closure record + deferred items + regression-
                                               watch protocol. §22.3 = closed live-verify outcome
                                               (was previously the only outstanding verification).
    docs/v2-migration/fork-local-inventory.md  §"Closure summary" table is the canonical place to
                                               check whether a v1 file was ported, retired, or
                                               deferred. Every v1 file is preserved on the
                                               v1-archive branch.
    docs/v2-migration/operational-gotchas.md   Durable runtime knowledge — service paths, build
                                               steps, git topology, provider/multimodal/reactions
                                               wiring, Slack interactivity, scheduled tasks.
                                               Append new gotchas here; reference numbers stable.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-28; its description line carries the closure summary.

## Git topology

```
johnmathews/nanoclaw          ← all fork work, all current commits pushed
├── main                       ← tracking origin/main (canonical v2)
├── v1-archive                 ← v1 frozen at 0bd42bb (every retired file recoverable here)
└── v1-final-2026-05-22 (tag)  ← annotated tag on 0bd42bb

On /srv/apps/nanoclaw (canonical working tree):
  origin    → https://github.com/johnmathews/nanoclaw.git  (default push target for main)
  upstream  → https://github.com/nanocoai/nanoclaw.git     (read-only — fetch upstream NanoClaw updates)
```

## What kind of session is this?

Pick the matching playbook:

### A. A regression in production usage

1. Tail `logs/nanoclaw.log` + `logs/nanoclaw.error.log` (durable, structured — not journald).
2. `curl http://127.0.0.1:3002/health` for the channel + queue + scheduled-task snapshot.
3. If a specific session went silent: bisect via `data/v2-sessions/<agent-group>/<session>/inbound.db` (host wrote?) → `outbound.db` (container replied?).
4. If you need to compare against v1 behaviour: `git show v1-archive:src/<file>.ts` to read the v1 source (every fork-local file is preserved there).
5. Log the incident as a new top-level `## §N` in `p3-notes.md`. That document remains the single source of truth for v1→v2 history.

### B. You want to reopen a deferred item

The deferred-items table is in `p3-notes.md` §22.2 (operator-facing) and `fork-local-inventory.md` §"Closure summary" (per-file). Current contents (trimmed to 2 on 2026-05-28):

- **W4.2 status-tracker** — progress-emoji reactions for non-native-typing channels. Reopen only if you wire a channel without native typing (Discord, Matrix, …).
- **§20 `skipImageMultimodal` host-side wiring** — per-attachment contract exists in `container/agent-runner/src/multimodal.ts` + tests; needs ~30 min to wire the host stamp from group config.

If you want something that *used* to be on this list (W4.6 remote-control, W5.1 Slack `thread_ts`/v6/`getThreadMessages`, W5.3 Gmail channel), see §22.2's "Removed from this list" note — the reopen path is either obvious (run `/add-gmail`) or the original code is on `v1-archive`. Nothing was lost.

When you reopen one: edit the row in `fork-local-inventory.md` in place + add a new `## §N` to `p3-notes.md`. Don't extend `implementation-plan.md` — that document is frozen at closure (and now lives under `docs/archive/`).

### C. New feature work (not regression, not deferred-item reopen)

Migration docs are frozen. New work lives in PR descriptions, `journal/`, or new top-level docs in `docs/`. Treat the project as a normal production codebase — `CLAUDE.md` at the root is the authoritative entry point.

## Operational gotchas

**Read `docs/v2-migration/operational-gotchas.md`** — durable runtime notes (service paths, build steps, git topology, provider/multimodal/reactions wiring, Slack interactivity, scheduled tasks). Append new gotchas to that file; reference numbers are stable. Highlights:

- Canonical working tree: `/srv/apps/nanoclaw`.
- v2 runs from `dist/`, not `src/`. `pnpm run build` is mandatory between any host-source edit and `systemctl --user restart nanoclaw-<install-slug>.service` (look the unit up via `systemctl --user list-units 'nanoclaw*'`).
- v2 logs: `logs/nanoclaw.{log,error.log}` (not journald).
- `/health` reachable at `127.0.0.1:3002`. After restart, sleep ≥ 6s before curling.
- OneCLI gateway on `127.0.0.1:10255`; web UI on `127.0.0.1:10254`.
- Git author identity workaround: no `user.name`/`user.email` set anywhere visible. Use `git -c user.name="John Mathews" -c user.email="mthwsjc@gmail.com" commit ...` per-command override.
- `main` tracks `origin/main`. Bare `git push` goes to the fork; `git fetch upstream` still works.
- v1-archive branch is load-bearing for recovery and audit lookups.

## What to deliver this session

- Whatever the session is about (regression fix / deferred-item reopen / new feature).
- Tests pass: `cd /srv/apps/nanoclaw && pnpm test` + `cd container/agent-runner && bun test`.
- v2 healthy after any service-touching change: `curl http://127.0.0.1:3002/health` returns 200.
- New runtime gotchas appended to `docs/v2-migration/operational-gotchas.md`.
- New incidents added as `## §N` entries in `p3-notes.md`.
- `git push origin main` at end of session.
- Refresh this file **only** if the workflow/contract changes (e.g. a new deferred-item gets reopened-and-deferred-again, or v2's runtime baseline shifts). Don't churn it for routine session handoff — there's no work-unit picker anymore.
