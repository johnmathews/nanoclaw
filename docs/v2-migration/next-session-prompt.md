# Next-session prompt — continue NanoClaw v1→v2 migration after W4.1 + installer-template watchdog patch

Copy the block below (everything between the `---` lines) into a new Claude Code session in `/srv/apps/nanoclaw-v2` to
continue the migration. The prompt is self-contained — the new session won't see this conversation.

> **Note on working directory:** canonical tree is `/srv/apps/nanoclaw-v2`. Start the next session there.
> `/srv/apps/nanoclaw` stays as the v1 tombstone for ~30 days (journal mount still points at it; W8.6 cleans up).

---

I'm continuing the NanoClaw v1→v2 migration. **State as of 2026-05-22 post-W4.1 + installer-template:** P0 + P1 + P2 +
P3 + W4.0 + W4.3 + W4.5 + W4.4 + Task A + W4.5.1 + `writeOutboundDirect` rw fix + **W4.1 sender-allowlist retire** +
**v2 installer-template watchdog patch** all complete. v2 is live in production at `/srv/apps/nanoclaw-v2`
(`nanoclaw-v2-787facac.service`, active+enabled, `Type=notify` + `WatchdogSec=30s`). v1 is stopped+disabled. WhatsApp
+ Slack inbound/outbound + scheduled tasks + `/health` on `127.0.0.1:3002` + chat `/usage` + chat `/status` (both
admin-gated) + `ncl usage` CLI all working.

**Git topology** (unchanged from Task A 2026-05-22):

```
johnmathews/nanoclaw          ← all fork work
├── main                       ← HEAD = 7cde667    (two HEAD commits LOCAL ONLY,
├── v1-archive                 ← v1 frozen at 0bd42bb     not yet pushed to origin)
└── v1-final-2026-05-22 (tag)  ← annotated tag on 0bd42bb

On /srv/apps/nanoclaw-v2 (canonical working tree):
  origin    → https://github.com/johnmathews/nanoclaw.git
  upstream  → https://github.com/nanocoai/nanoclaw.git

On /srv/apps/nanoclaw (v1 tombstone — DO NOT `git pull` here):
  origin    → https://github.com/johnmathews/nanoclaw.git
  Local main still = 0bd42bb (diverges from remote main).
  Leave intact while journal mount uses /srv/apps/nanoclaw/journal/.
```

**Read first**, in this order (all paths inside `/srv/apps/nanoclaw-v2`):

    docs/v2-migration/p3-notes.md              §10 W4.3, §11 W4.5, §12 fork restructuring,
                                               §13 W4.4, §14 W4.5.1 + writeOutboundDirect
                                               fix, §15 W4.1 retire, §16 installer-template
                                               watchdog patch — full audit per work unit.
    docs/v2-migration/implementation-plan.md   §5 P4 remaining order:
                                               W4.7 → chat-sdk-bridge audit → Slack
                                               interactivity port → W4.6 (defer).
    docs/v2-migration/fork-local-inventory.md  Updated 2026-05-22:
                                               sender-allowlist + mount-security both
                                               retired; health/watchdog/usage/status all
                                               done; only remote-control + transcription
                                               + channel customizations left.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-22
post-W4.1 + installer-template. Read items #26-#33 in operational gotchas. Items new this session: #31 (installer-
template now writes `Type=notify`; live unit unchanged because W4.3 hand-edit already had the flags), #32 (git author
identity workaround — no `user.name`/`user.email` set anywhere visible; use per-command `-c user.name=... -c
user.email=...` override), #33 (`v1-archive` branch is load-bearing for retire audits — read v1 files there or from
`/srv/apps/nanoclaw` while it exists, not from v2 main).

**Working tree state on `/srv/apps/nanoclaw-v2` (start-of-session):**

- Committed but **not yet pushed**: `574c7b1` (W4.1 retire docs), `7cde667` (installer-template watchdog patch).
  Decide whether to `git push origin main` at session start.
- Uncommitted, deliberately: skill output from `/migrate-from-v1`, `/add-gmail-tool`, `/add-gcal-tool` —
  `src/channels/{slack,resend,whatsapp,index}.ts`, `container/skills/{capabilities,pdf-reader,reactions,status}/`,
  `setup/{groups,whatsapp-auth}.ts`, `package.json` + `pnpm-lock.yaml` (slack/baileys/resend deps),
  `container/Dockerfile` (gmail/calendar MCP additions), `.claude/settings.json` (gh permission),
  `groups/main/CLAUDE.md` (modified) + `groups/global/CLAUDE.md` (deleted, runtime state). Decide what to do
  with them as a separate concern — probably commit on main once reviewed, or on a `v2-skill-output` branch.
  Group-memory files (`groups/*/CLAUDE.md`) should never be in git.

## Pick one of these next units (small, in priority order)

### Option 1 (Recommended): chat-sdk-bridge audit (~60-90 min)

v2's `src/chat-sdk-bridge.ts` is the shim between the inbound channel adapter and the SDK-side agent. v2's adapter
already exposes images, voice, PDF attachments, reactions, typing indicators, and streaming (verified by grep at W4.0
time). What's UNVERIFIED is whether the bridge forwards each of those to the agent, and whether the agent surfaces
them through `mcp__nanoclaw__send_message`/`send_blocks` on the way back.

1. Map the universe: grep v2 for `chat-sdk-bridge` references; read the file top-to-bottom.
2. Build a matrix: rows = {image, voice, PDF, reaction-received, reaction-sent, typing-start/stop, streaming-text}.
   Columns = {adapter exposes?, bridge forwards inbound?, agent receives in container?, agent can emit outbound?,
   adapter delivers outbound?}. Fill from code reads.
3. For each broken cell, classify: gap-by-design / missing-port / latent-bug.
4. Decide what to fix in this session vs. defer to a follow-up.
5. Commit + add §17 to `p3-notes.md` with the matrix + decisions.

The result either confirms "nothing to port" (clean §17 + retire claim), or surfaces 1-3 small follow-ups. Either
outcome is useful.

### Option 2: W4.7 Journal MCP cron verify (~10 min observe, then docs)

`JOURNAL_MCP_URL` + `JOURNAL_API_TOKEN` are wired into the v2 container env (per project memory item #14 in
[[reference_journal_mcp]] and p3-notes §3). What's pending is confirming the morning-report cron (07:28 CEST) and
docs-summary cron (09:03 CEST) actually use journal tools end-to-end on a real fire. Tomorrow's run is the next
natural verification opportunity.

1. Wait until 09:05+ (both crons have fired).
2. Pull the morning-report output from the main-group's outbound log; check for `mcp__journal__journal_*` tool
   invocations in the agent-runner stderr (or via `data/v2-sessions/ag-main/sess-*/logs/`).
3. If absent, dig — the env var may not reach the container, or the SDK MCP wiring may be wrong.
4. Mark W4.7 DONE in `project_v2_migration.md` + `fork-local-inventory.md` once verified; append §17 to
   `p3-notes.md`.

### Option 3: Slack interactivity port (~60-90 min)

Carry-forward from W4.0. v1's `src/channels/slack.ts` had `app.action(/^nanoclaw_(checkbox|confirm)_/)` handlers for
the git-maintenance branch-delete confirm flow (Mon/Thu 02:03 CEST cron). v2's Slack adapter receives interactivity
payloads at `/webhook/slack` but `chat-sdk-bridge.ts` may not surface them to the agent. Without this port, the
git-maintenance cron fires but the confirmation can't be clicked through Slack.

1. Find v1's `app.action` handler shape (likely in `/srv/apps/nanoclaw/src/channels/slack.ts` on the `v1-archive`
   branch).
2. Read v2's Slack adapter to see where `block_actions` payloads land in the inbound event stream.
3. Port the handler into v2's appropriate layer (likely a new responder in the bridge, or a routed event the agent
   can subscribe to via MCP).
4. End-to-end test: trigger the git-maintenance flow, see the checkbox, click, confirm the agent sees the click.
5. Commit + add §17 (or §18 if Option 1 also ran) to `p3-notes.md`.

This unit may overlap with Option 1's bridge audit — running Option 1 first will inform the right port shape.

### Option 4: skill-output triage + push pending commits (~30 min)

Lower-risk cleanup work. Goes well alongside Option 2 (which is mostly observation).

1. `git diff src/channels/whatsapp.ts container/skills/...` etc. for each uncommitted file.
2. For each file, decide: commit on `main`, move to a `v2-skill-output` branch, or discard.
3. `git push origin main` for the two pending commits (`574c7b1`, `7cde667`).
4. If you commit any skill-output, decide structure: one big "skill output catch-up" commit, or split per skill.

## Out of scope this session

- **Gmail channel re-install** — deferred.
- **W4.6 remote-control** — defer (nice-to-have).
- Anything in P5/P7/P8.
- Touching the systemd unit on the running install (NRestarts=0; keep it green). The installer-template patch is
  fresh-install-only — the live unit doesn't change.

## Operational gotchas (carry into this session)

1. **Canonical working tree** is `/srv/apps/nanoclaw-v2`. Start the next session there.
2. **Never restart v1's service** (`nanoclaw.service`). It's stopped+disabled; restarting would conflict with v2 on
   the WhatsApp Baileys keystore.
3. **`pnpm`** at `~/.npm-global/bin/pnpm`, **`onecli`** same dir, **`ncl`** at `/srv/apps/nanoclaw-v2/bin/ncl` —
   none on Claude Code's default PATH. Prefix `PATH=…:$PATH` or use absolute paths.
4. **v2's logs** go to `/srv/apps/nanoclaw-v2/logs/nanoclaw.{log,error.log}`, not journald.
   `journalctl --user -u nanoclaw-v2-787facac.service` only shows systemd-side events.
5. **v2 runs from `dist/`, not `src/`.** `ExecStart=/usr/bin/node /srv/apps/nanoclaw-v2/dist/index.js`. After any
   source edit, `cd /srv/apps/nanoclaw-v2 && pnpm run build` (= `tsc`) before `systemctl --user restart`.
6. **OneCLI gateway** runs on `127.0.0.1:10255`, not 10254. 10254 is the web UI.
7. **`/health` reachable** from anywhere on the host loopback. `curl http://127.0.0.1:3002/health` returns the
   snapshot. After `systemctl --user restart`, sleep ≥6s before curling — channels reconnect first.
8. **`Type=notify` requires `READY=1`** from the process before systemd marks the unit active. If you change startup
   ordering in `src/index.ts`, make sure `initWatchdog()` still fires and the start path reaches "NanoClaw running".
9. **`HOST_RESPONDER_COMMANDS` renderers** run fire-and-forget off the hot path (W4.5 pattern). Render failures fall
   back to inline error messages — the original inbound row is already marked processed (no retry). Acceptable for
   idempotent commands; reconsider for state-mutating ones.
10. **Mount allowlist** after P3+W4.5: 3 `allowedRoots` (`/srv/apps/nanoclaw`, `/srv/apps/nanoclaw-v2`,
    `/home/john/.gmail-mcp`) + `~/.calendar-mcp` added by `/add-gcal-tool`. 17 `blockedPatterns`.
11. **v2 `additionalMounts` `containerPath` must be RELATIVE** (p3-notes §3.5). v2 prefixes with `/workspace/extra/`.
    Absolute paths are rejected.
12. **DO NOT `git pull` on `/srv/apps/nanoclaw`.** It's the v1 working tree; its local main still = `0bd42bb` but
    remote main = v2 head `7cde667`. A pull would try to merge v2 into v1's tree.
13. **Migration docs now live on v2's main** at `docs/v2-migration/`. Edit there. The v1 tree still has a frozen copy
    at `0bd42bb` (= `v1-archive` branch). Don't dual-maintain.
14. **`writeOutboundDirect` now writes** (fixed 2026-05-22 in `d8c04b8`). Non-admin slash commands deliver
    "Permission denied" to the channel instead of failing silently. If you add new gate paths that call
    `writeOutboundDirect`, keep the invariant: the function is only safe when no container is mid-write to this
    session's `outbound.db` (which holds while the gate runs before `writeSessionMessage`).
15. **v2 installer-template now writes `Type=notify`** (new in `7cde667`). Single template at `setup/service.ts`
    `setupSystemd()`; test shadow at `setup/service.test.ts` `generateSystemdUnit()` (production function isn't
    exported). Fresh-install-only — the live unit isn't touched.
16. **Git author identity workaround**: there is no `user.name`/`user.email` in `~/.gitconfig`, repo `.git/config`,
    or env vars, yet prior commits show `John Mathews <mthwsjc@gmail.com>` as author. Use
    `git -c user.name="John Mathews" -c user.email="mthwsjc@gmail.com" commit ...` per-command override (does NOT
    modify config, so satisfies CLAUDE.md "NEVER update the git config").
17. **`v1-archive` branch is load-bearing for retire audits.** When v2 retires a v1 file (W4.4 mount-security, W4.1
    sender-allowlist), the file disappears from `johnmathews/nanoclaw` `main` but remains accessible at
    `johnmathews/nanoclaw` `v1-archive`. Pattern for future retires: read v1 files via that branch or via
    `/srv/apps/nanoclaw` while it still exists; don't blank-grep against v2's `main`.

## Rollback recipes

- **For W4.1 retire** (`574c7b1`): `git revert 574c7b1` (docs-only — restores the row to `decide-at-port-time`).
- **For installer-template watchdog patch** (`7cde667`): `git revert 7cde667 && pnpm run build`. Live
  `nanoclaw-v2-787facac.service` is unaffected; the revert only changes what `pnpm run setup` would emit on a fresh
  install. Probably not worth reverting — it's a strict improvement on the previous template.
- **For Task A topology** (the v1 → v2 `main` swap): `git push --force-with-lease origin v1-archive:main` from any
  working tree with `johnmathews/nanoclaw` as a remote. Restores v1 `main`. The `v1-archive` branch +
  `v1-final-2026-05-22` tag are durable.
- **For a service regression**: `git checkout -- <files>` on v2; `pnpm run build`;
  `systemctl --user restart nanoclaw-v2-787facac.service`. Keep `NRestarts=0`.
- **For a bad commit on main**: `git revert <sha>` (preserves history) or
  `git reset --hard <previous-sha> && git push --force-with-lease` (rewrites — only if absolutely necessary).

## What to deliver this session

1. Whichever option(s) from §"Pick one of these next units" you tackled, with their per-section deliverables.
2. Tests pass (`cd /srv/apps/nanoclaw-v2 && pnpm test` — baseline is 37 files / 424 tests post-installer-template).
3. v2 healthy after any service-touching change (`curl http://127.0.0.1:3002/health` returns 200).
4. `project_v2_migration.md` memory updated with completed items + new operational gotchas.
5. **Decide on `git push origin main`** for the two LOCAL-ONLY commits (`574c7b1`, `7cde667`) — push at session
   start or end, your call. Note: the user normally pushes these as part of the standard flow.
6. End-of-session: produce a new next-session-prompt for the work unit after this one (write at
   `docs/v2-migration/next-session-prompt.md` on v2's working tree).
