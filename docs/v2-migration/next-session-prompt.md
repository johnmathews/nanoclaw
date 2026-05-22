# Next-session prompt — continue NanoClaw v1→v2 migration after W4.5

Copy the block below (everything between the `---` lines) into a new Claude Code session in `/srv/apps/nanoclaw` to continue the migration. The prompt is self-contained — the new session won't see this conversation.

---

I'm continuing the NanoClaw v1→v2 migration. P0–P3 + W4.0 + W4.3 + W4.5 are complete. v2 is live in production at /srv/apps/nanoclaw-v2 (`nanoclaw-v2-787facac.service`, active+enabled, `Type=notify` + `WatchdogSec=30s`). v1 is stopped+disabled. WhatsApp + Slack + scheduled tasks + `/health` on `127.0.0.1:3002` all working. `/usage` is now available as both `ncl usage` (CLI) and chat `/usage` (admin-gated, handled inline by command-gate's `respond` action). This session's job:

**Primary task: W4.4 — mount-security audit + v1 fork-local `mount-security.ts` retire-or-port decision.**

READ FIRST, in this order:

    /srv/apps/nanoclaw/docs/v2-migration/p3-notes.md              (§9 W4.0 + §10 W4.3 + §11 W4.5
                                                                   resolution logs — esp. §11 for
                                                                   the OneCLI / token-source decision
                                                                   chain and §3.5 / §6 gotcha #6 on
                                                                   v2's relative-containerPath rule)
    /srv/apps/nanoclaw/docs/v2-migration/implementation-plan.md   (W4.4 in §5; remaining order
                                                                   W4.4 → W4.5.1 → W4.7 → W4.6,
                                                                   plus follow-ups W4.8, W4.9,
                                                                   plus "installer-template
                                                                   watchdog patch" from W4.3)
    /srv/apps/nanoclaw/docs/SECURITY.md §1 + §2                   (canonical trust model — what
                                                                   mount-security is defending
                                                                   against in v1)

Project memory at ~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md is current as of 2026-05-22 post-W4.5 — read for carry-forward state, esp. items #21-#25 in operational gotchas (v2 runs from dist/, OneCLI port semantics, `/usage` chat surface details).

Working tree on /srv/apps/nanoclaw is uncommitted from P0+P1+P2+P3+W4.0+W4.3+W4.5 docs work. Working tree on /srv/apps/nanoclaw-v2 is uncommitted from W4.3 (health/watchdog code) + W4.5 (usage code). Do NOT commit during this session unless I ask.

## Carry-forward housekeeping (do early if time allows)

1. **v2 installer-template watchdog patch** (still open from p3-notes §10.2 + §11.4) — v2's `/setup` and `bash setup.sh` still write `Type=simple` unit files. Locate the template in v2's `setup/` (likely `setup/lib/systemd-unit.sh` or similar) and bake `Type=notify` + `NotifyAccess=all` + `WatchdogSec=30s` in. Until this lands, every fresh install needs a manual unit edit. Tractable if W4.4 finishes early.

2. **W4.5.1 `/status` chat fold-in** (NEW, from W4.5 — see implementation-plan §5 W4.5.1) — single entry in `HOST_RESPONDER_COMMANDS` + a `formatHealthText` helper that wraps the existing `src/health.ts` snapshot composer (already wired for the `/health` HTTP endpoint). Estimated <30 min once W4.4 settles — or fold into W4.4's commit if it's convenient.

3. **v2's untracked working tree** at `/srv/apps/nanoclaw-v2` has the channel-adapter files from `/migrate-from-v1` (`src/channels/{slack,resend,whatsapp,index}.ts`, plus container/skills/*). Leave alone — those are upstream skill output.

## W4.4 scope — mount-security audit

v1's `src/mount-security.ts` is a load-bearing security boundary: realpath resolution + per-`additionalMounts` allowlist check + colon-injection guard on the `-v <host>:<container>:rw` arg surface + fail-closed on missing allowlist file. v2 has `src/modules/mount-security/index.ts` which already enforces *something* (per p3-notes §3.5: relative `containerPath` only, rejection of `..`, empty strings, and colons). What's not yet verified: whether v2's version covers ALL of v1's surface, or whether the fork still needs a redundant check on top.

The decision is: (a) **retire** v1's `src/mount-security.ts` if v2's covers everything we care about, or (b) **port** any gaps onto v2's module.

v1 source (READ FIRST):

- `src/mount-security.ts` — the full file. ~200 lines. Read top-to-bottom and inventory each check.
- `src/mount-security.test.ts` — the tests. Each test case is a documented attack/defence scenario; use as a checklist for v2's coverage.
- `~/.config/nanoclaw/mount-allowlist.json` — current allowlist on this host. Read to understand what production semantics need to be preserved (3 allowedRoots post-P3: `/srv/apps/nanoclaw`, `/srv/apps/nanoclaw-v2`, `/home/john/.gmail-mcp` + `~/.calendar-mcp` from `/add-gcal-tool`; 17 blockedPatterns).

v2 source (READ AFTER v1):

- `/srv/apps/nanoclaw-v2/src/modules/mount-security/index.ts` — v2's enforcer.
- `/srv/apps/nanoclaw-v2/src/modules/mount-security/*.test.ts` (if present) — what's already covered.
- Find where v2 calls `mount-security` from — grep for the module's exports in `src/`. The call site tells you what gets validated and when (likely `container-runner.ts` during `buildContainerArgs`).

**Action:**

1. Read v1's `mount-security.ts` + test file. Make a list of checks:
    - realpath canonicalisation
    - allowlist root prefix match
    - blocked-pattern dotfile defence (`.aws`, `.ssh`, `.gnupg`, etc.)
    - colon-injection guard on host or container paths
    - empty / `..` / absolute-vs-relative rules
    - `nonMainReadOnly` flag (main group can write; others read-only)
    - fail-closed behaviour on missing/malformed allowlist file
2. Read v2's mount-security module + tests. For each check on the v1 list, mark "covered" / "not covered" / "different semantics".
3. Verify the allowlist format is compatible (or note migration). v2 reads from the same `~/.config/nanoclaw/mount-allowlist.json` per p3-notes §6 gotcha #7.
4. **Decide retire vs port.** If retire: delete v1's `mount-security.ts` from the fork-local inventory in `docs/v2-migration/fork-local-inventory.md` and document the decision. If port: implement the missing checks atop v2's module, write tests for the new ones.
5. Verify by running v2's test suite (`cd /srv/apps/nanoclaw-v2 && pnpm test`) and confirming all pass after any changes.
6. Run `cd /srv/apps/nanoclaw-v2 && pnpm run build` after any source edits (v2 runs from `dist/`, see gotcha #21 below).
7. Restart v2 (`systemctl --user restart nanoclaw-v2-787facac.service`) only if mount-security code changed — and then sleep ≥6s before checking `/health`.

## After W4.4: optional W4.5.1 `/status` fold-in if there's time

See "Carry-forward housekeeping #2" above. Quick checklist:

1. Look at v2's `src/index.ts` for the `snapshotHealth()` function that wires the health snapshot — confirm it's callable from outside `index.ts` or refactor it to be importable.
2. In `src/command-gate.ts`, add `'/status': () => formatHealthText(snapshotHealth())` to `HOST_RESPONDER_COMMANDS`.
3. Add one test case to `src/command-gate.test.ts`.
4. Build, restart, verify in Slack.

## Out of scope this session

- W4.5 `/usage` — DONE. Read p3-notes §11 if you need to understand the existing surface.
- W4.7 journal MCP confirm — defer.
- W4.6 remote-control — defer (nice-to-have).
- W4.1 sender allowlist — likely retire (v1 never enforced it in production per p3-notes §3.6). Audit alongside W4.4 if it's natural; otherwise next session.
- W4.8 Slack interactivity / `block_actions` port — follow-up; not this session.
- W4.9 chat-sdk-bridge consumer audit — follow-up; not this session.
- Gmail channel re-install — deferred.
- Anything in P5/P7/P8.
- Touching the systemd unit (NRestarts=0; keep it green).

## Operational gotchas (carry into this session)

1. **Never restart v1's service** (`nanoclaw.service`). It's stopped+disabled; restarting would conflict with v2 on the WhatsApp Baileys keystore.
2. **`pnpm` at `~/.npm-global/bin/pnpm`**, `onecli` same dir, `ncl` at `/srv/apps/nanoclaw-v2/bin/ncl` — none on Claude Code's default PATH. Prefix with `PATH=…:$PATH` or use absolute paths.
3. **v2's logs** go to `/srv/apps/nanoclaw-v2/logs/nanoclaw.{log,error.log}`, not journald. `journalctl --user -u nanoclaw-v2-787facac.service` only shows systemd-side events (start, watchdog timeouts, etc.).
4. **v2 runs from `dist/`, not `src/`.** `ExecStart=/usr/bin/node /srv/apps/nanoclaw-v2/dist/index.js`. After any source edit, `cd /srv/apps/nanoclaw-v2 && pnpm run build` (= `tsc`) before `systemctl --user restart`. v1 ran via tsx and skipped this step — easy regression for muscle-memory.
5. **OneCLI gateway runs on `127.0.0.1:10255`**, not 10254. 10254 is the web UI. OneCLI's secret-injection contract injects `x-api-key`-style auth for `type=anthropic` secrets, NOT OAuth Bearer + anthropic-beta — see p3-notes §11 for full context. Unlikely to be relevant to W4.4 but good to know.
6. **OneCLI vault entry for the Anthropic subscription token:** `name=Anthropic, type=anthropic, host=api.anthropic.com, id=5705cd20-ea15-41d4-80fe-3ee57c5b2f92`. If the token expires, refresh via `claude setup-token` then `onecli secrets update Anthropic --value <token>`. Do not paste tokens into chat.
7. **W4.3-introduced gotcha:** `/health` reachable from anywhere on the host loopback. `curl http://127.0.0.1:3002/health` returns the snapshot the operator's `/status` chat command will render once W4.5.1 lands.
8. **W4.3-introduced gotcha:** after `systemctl --user restart`, the `/health` endpoint is unreachable for ~4-6s while channels reconnect. Sleep ≥6s or poll-until-ready in any restart-then-check script.
9. **`Type=notify` requires `READY=1` from the process** before systemd marks the unit active. If W4.4 changes startup ordering in `src/index.ts`, make sure the `initWatchdog()` call still fires and the start path still reaches "NanoClaw running" — otherwise the unit hangs in `activating` until `TimeoutStartSec=90s` elapses. (Unlikely for a mount-security audit, but note for anything that touches index.ts.)
10. **W4.5-introduced gotcha:** the chat-side `/usage` runs the renderer off the hot path via `.then().catch()`. If you extend `HOST_RESPONDER_COMMANDS` (e.g. for W4.5.1 `/status`), follow the same fire-and-forget pattern — long-running renderers must not block inbound message handling. Render failures fall back to an inline error message in the same channel; the original inbound row is already marked processed (no retry).
11. **`/usage` chat command is admin-gated** like `/clear` (`isAdmin()` in command-gate). `ncl usage` is `access=open`. If you add `/status` chat, gate it the same way — see command-gate.ts for the pattern.
12. **Mount allowlist after P3+W4.5:** 3 `allowedRoots` (`/srv/apps/nanoclaw`, `/srv/apps/nanoclaw-v2`, `/home/john/.gmail-mcp`) + `~/.calendar-mcp` added by `/add-gcal-tool`. 17 `blockedPatterns`. W4.4 should not change this unless explicitly retiring/adding a path.
13. **v2 `additionalMounts` `containerPath` must be RELATIVE** (p3-notes §3.5). v2 prefixes with `/workspace/extra/`. Absolute paths like `/home/node/.gmail-mcp` are REJECTED. The colon-injection guard works on the relative path too — v1's defence against `-v <host>:<container>:rw` injection is structurally preserved by v2's stricter rules.

## What to deliver this session

1. W4.4 decision: retire or port v1's `src/mount-security.ts`, with the decision documented in `docs/v2-migration/p3-notes.md` §12 (new section).
2. If retire: `docs/v2-migration/fork-local-inventory.md` updated; v1's file untouched on disk (don't delete from `/srv/apps/nanoclaw` until P7-final/P8 cleanup).
3. If port: code changes on v2 atop `src/modules/mount-security/`, plus tests, plus `pnpm run build` + restart.
4. Tests pass on v2 (`cd /srv/apps/nanoclaw-v2 && pnpm test` — should still be at 36 files / 389 tests from W4.5 baseline, plus whatever you add).
5. p3-notes.md appended with §12 W4.4 resolution log (date, retire-vs-port decision, gap matrix if any, gotchas).
6. project_v2_migration.md memory updated: W4.4 done, next work unit listed.
7. Optionally: W4.5.1 `/status` fold-in done if time permits; W4.5.1 section in p3-notes §13.
8. End-of-session: produce a next-session prompt for the next work unit (W4.5.1 if you didn't fold it in, else W4.7 / installer-template / interactivity port).

Service-level rollback: `git checkout --` any new v2 source files; `pnpm run build`; `systemctl --user restart nanoclaw-v2-787facac.service`. v2 currently has `NRestarts=0` from the post-W4.5 restart — keep it green by NOT touching the systemd unit unless W4.4 itself requires it (it shouldn't).

---
