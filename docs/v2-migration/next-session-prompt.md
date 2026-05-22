# Next-session prompt — continue NanoClaw v1→v2 migration after W4.4 + fork restructuring

Copy the block below (everything between the `---` lines) into a new Claude Code session in `/srv/apps/nanoclaw-v2` to continue the migration. The prompt is self-contained — the new session won't see this conversation.

> **Note on working directory:** previous sessions ran from `/srv/apps/nanoclaw` (the v1 working tree, where the planning docs lived). Post-Task A the canonical tree is `/srv/apps/nanoclaw-v2`. Start the next session there. `/srv/apps/nanoclaw` stays as the v1 tombstone for ~30 days (journal mount still points at it; W8.6 cleans up).

---

I'm continuing the NanoClaw v1→v2 migration. **State as of 2026-05-22 post-W4.4:** P0 + P1 + P2 + P3 + W4.0 + W4.3 + W4.5 + **W4.4** + **Task A fork restructuring** all complete. v2 is live in production at `/srv/apps/nanoclaw-v2` (`nanoclaw-v2-787facac.service`, active+enabled, `Type=notify` + `WatchdogSec=30s`). v1 is stopped+disabled. WhatsApp + Slack inbound/outbound + scheduled tasks + `/health` on `127.0.0.1:3002` + chat `/usage` (admin-gated) + `ncl usage` CLI all working.

**Git topology** (canonical now, established in Task A 2026-05-22):

```
johnmathews/nanoclaw          ← all fork work
├── main                       ← v2 + W4.3 + W4.5 + W4.4    HEAD = 9d7fea3
├── v1-archive                 ← v1 frozen at 0bd42bb       (rollback target)
└── v1-final-2026-05-22 (tag)  ← annotated tag on 0bd42bb   (immutable marker)

On /srv/apps/nanoclaw-v2 (canonical working tree from now on):
  origin    → https://github.com/johnmathews/nanoclaw.git
  upstream  → https://github.com/nanocoai/nanoclaw.git

On /srv/apps/nanoclaw (v1 tombstone — DO NOT `git pull` here):
  origin    → https://github.com/johnmathews/nanoclaw.git
  Local main still = 0bd42bb (now diverges from remote main = 9d7fea3)
  Leave intact while journal mount uses /srv/apps/nanoclaw/journal/.
```

**Read first**, in this order (all paths inside `/srv/apps/nanoclaw-v2`):

    docs/v2-migration/p3-notes.md              §10 W4.3, §11 W4.5, §12 fork
                                               restructuring, §13 W4.4 — full
                                               audit + retire reasoning + the
                                               new git topology end-state and
                                               rollback recipe.
    docs/v2-migration/implementation-plan.md   §5 P4 remaining order:
                                               W4.5.1 → W4.1 → installer-template
                                               watchdog patch → W4.7 → W4.6.
    docs/v2-migration/fork-local-inventory.md  Updated 2026-05-22:
                                               mount-security retired,
                                               health/watchdog/usage marked done.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-22 post-W4.4. Read items #26-#29 in operational gotchas (new git topology, doc locations, uncommitted skill-output handling, p3-notes section numbering).

**Working tree state on /srv/apps/nanoclaw-v2** (start-of-session):

- Committed and pushed: W4.3 (`0638657`), W4.5 (`e968b39`), W4.4 + docs migration (`9d7fea3`).
- **Uncommitted, deliberately**: skill output from `/migrate-from-v1`, `/add-gmail-tool`, `/add-gcal-tool` — `src/channels/{slack,resend,whatsapp,index}.ts`, `container/skills/{capabilities,pdf-reader,reactions,status}/`, `setup/{groups,whatsapp-auth}.ts`, `package.json` + `pnpm-lock.yaml` (slack/baileys/resend deps), `container/Dockerfile` (gmail/calendar MCP additions), `.claude/settings.json` (gh permission), `groups/main/CLAUDE.md` (modified) + `groups/global/CLAUDE.md` (deleted, runtime state). Decide what to do with them as a separate concern — probably commit on main once reviewed, or on a `v2-skill-output` branch. Group-memory files (`groups/*/CLAUDE.md`) should never be in git.

## Pick one of these next units (small, in priority order)

### Option 1 (Recommended): W4.5.1 — `/status` chat command fold-in (<30 min)

Single entry in `src/command-gate.ts` `HOST_RESPONDER_COMMANDS` + a tiny `formatHealthText` helper that wraps the existing `snapshotHealth()` from `src/index.ts`. Same shape as `/usage` (see W4.5 in p3-notes §11). Admin-gated like `/clear` and `/usage`. After commit, build + restart + verify in Slack.

1. `snapshotHealth()` is currently a local function in `src/index.ts`. Either export it directly, or refactor into `src/health.ts` (pure-function module). Reading the diff at commit `0638657` shows what's where.
2. Add `'/status': () => formatHealthText(snapshotHealth())` to `HOST_RESPONDER_COMMANDS`.
3. Add one test case to `src/command-gate.test.ts` mirroring the existing `/usage` test pattern.
4. `pnpm run build && systemctl --user restart nanoclaw-v2-787facac.service && sleep 6 && curl -s http://127.0.0.1:3002/health | jq .` — confirm v2 healthy post-restart.
5. Verify in Slack DM as admin user: send `/status`, expect the formatted text. Send as non-admin (or unauthenticated) → expect "Permission denied".
6. Commit: `feat(status): /status chat command (W4.5.1)`.
7. Append §14 to `docs/v2-migration/p3-notes.md` documenting the fold-in.

### Option 2: W4.1 — sender-allowlist retire (likely ~30 min)

v1 had a `src/sender-allowlist.ts` for per-chat sender gating. Per project memory, the allowlist file (`~/.config/nanoclaw/sender-allowlist.json`) doesn't exist on the host — so v1 never enforced it in production. Likely a clean retire.

1. Confirm: `ls ~/.config/nanoclaw/sender-allowlist.json` — expect "No such file or directory".
2. Confirm v2 has no `src/modules/sender-allowlist/` or equivalent: `grep -rn "sender-allowlist\|senderAllowlist" /srv/apps/nanoclaw-v2/src/`.
3. Audit v1's `src/sender-allowlist.ts` for any callers that have semantic equivalents in v2 (likely none, since v2's gating happens at the `command-gate.ts` `isAdmin` layer + the `cli_scope` allowlist for CLI surfaces).
4. Retire: update `docs/v2-migration/fork-local-inventory.md` to mark sender-allowlist retired. Add §15 to p3-notes.md with the audit + reasoning.
5. Tests-only commit if any (no source changes likely): `chore(audit): retire v1 sender-allowlist (W4.1)`.

### Option 3: v2 installer-template watchdog patch

v2's `/setup` (and `bash setup.sh`) still writes `Type=simple` unit files for fresh installs — so `initWatchdog()` returns null and the watchdog layer is silently disabled. Every fresh install today needs a manual edit to flip the unit to `Type=notify` + `NotifyAccess=all` + `WatchdogSec=30s`.

1. Find the unit-file template in `/srv/apps/nanoclaw-v2/setup/` (likely `setup/lib/systemd-unit.sh` or `setup/install.ts`).
2. Bake in the watchdog flags.
3. Don't disturb the macOS path (launchd, not systemd — keep it conditional).
4. Test the template generator if there is one.
5. Commit + update p3-notes §16.

### Option 4 (do all three as a small batch, ~90 min total)

W4.5.1 → W4.1 → installer-template, each on its own commit. Same session.

## Out of scope this session

- W4.7 journal MCP confirm — defer.
- W4.6 remote-control — defer (nice-to-have).
- W4.8 Slack interactivity / `block_actions` port — follow-up; not yet.
- W4.9 chat-sdk-bridge audit — follow-up; not yet.
- Gmail channel re-install — deferred.
- Anything in P5/P7/P8.
- Committing the uncommitted skill-output files — separate concern.
- Touching the systemd unit beyond the installer-template work (NRestarts=0; keep it green).

## Operational gotchas (carry into this session)

1. **Canonical working tree is `/srv/apps/nanoclaw-v2`.** Start the next session there.
2. **Never restart v1's service** (`nanoclaw.service`). It's stopped+disabled; restarting would conflict with v2 on the WhatsApp Baileys keystore.
3. **`pnpm` at `~/.npm-global/bin/pnpm`**, `onecli` same dir, `ncl` at `/srv/apps/nanoclaw-v2/bin/ncl` — none on Claude Code's default PATH. Prefix `PATH=…:$PATH` or use absolute paths.
4. **v2's logs** go to `/srv/apps/nanoclaw-v2/logs/nanoclaw.{log,error.log}`, not journald. `journalctl --user -u nanoclaw-v2-787facac.service` only shows systemd-side events.
5. **v2 runs from `dist/`, not `src/`.** `ExecStart=/usr/bin/node /srv/apps/nanoclaw-v2/dist/index.js`. After any source edit, `cd /srv/apps/nanoclaw-v2 && pnpm run build` (= `tsc`) before `systemctl --user restart`.
6. **OneCLI gateway runs on `127.0.0.1:10255`**, not 10254. 10254 is the web UI.
7. **`/health` reachable from anywhere on the host loopback.** `curl http://127.0.0.1:3002/health` returns the snapshot.
8. **After `systemctl --user restart`**, the `/health` endpoint is unreachable for ~4-6s while channels reconnect. Sleep ≥6s in any restart-then-check script.
9. **`Type=notify` requires `READY=1`** from the process before systemd marks the unit active. If you change startup ordering in `src/index.ts`, make sure `initWatchdog()` still fires and the start path reaches "NanoClaw running".
10. **`HOST_RESPONDER_COMMANDS` renderers run fire-and-forget** off the hot path (W4.5 pattern). Render failures fall back to inline error messages — the original inbound row is already marked processed (no retry). Acceptable for idempotent commands; reconsider for state-mutating ones.
11. **Mount allowlist after P3+W4.5:** 3 `allowedRoots` (`/srv/apps/nanoclaw`, `/srv/apps/nanoclaw-v2`, `/home/john/.gmail-mcp`) + `~/.calendar-mcp` added by `/add-gcal-tool`. 17 `blockedPatterns`.
12. **v2 `additionalMounts` `containerPath` must be RELATIVE** (p3-notes §3.5). v2 prefixes with `/workspace/extra/`. Absolute paths are rejected.
13. **DO NOT `git pull` on `/srv/apps/nanoclaw`.** It's the v1 working tree; its local main still = 0bd42bb but remote main = v2 head 9d7fea3. A pull would try to merge v2 into v1's tree.
14. **Migration docs now live on v2's main** at `docs/v2-migration/`. Edit there. The v1 tree still has a frozen copy at `0bd42bb` (= `v1-archive` branch). Don't dual-maintain.

## Rollback recipes

- **For Task A topology** (the v1 → v2 main swap): `git push --force-with-lease origin v1-archive:main` from any working tree with `johnmathews/nanoclaw` as a remote. Restores v1 main. The `v1-archive` branch + `v1-final-2026-05-22` tag are durable.
- **For a service regression**: `git checkout -- <files>` on v2; `pnpm run build`; `systemctl --user restart nanoclaw-v2-787facac.service`. Keep `NRestarts=0`.
- **For a bad commit on main**: `git revert <sha>` (preserves history) or `git reset --hard <previous-sha> && git push --force-with-lease` (rewrites — only if absolutely necessary).

## What to deliver this session

1. Whichever option(s) from §"Pick one of these next units" you tackled, with their per-section deliverables.
2. Tests pass (`cd /srv/apps/nanoclaw-v2 && pnpm test` — baseline is 37 files / 417 tests post-W4.4).
3. v2 healthy after any service-touching change (`curl http://127.0.0.1:3002/health` returns 200).
4. `project_v2_migration.md` memory updated with completed items + new operational gotchas.
5. **End-of-session: produce a new next-session-prompt** for the work unit after this one (write at `docs/v2-migration/next-session-prompt.md` on v2's working tree).

---
