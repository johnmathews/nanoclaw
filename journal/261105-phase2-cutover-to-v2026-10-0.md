# Phase 2 cutover: the fork now runs on upstream v2026.10.0

**Date:** 2026-11-05 (into 2026-11-06). **Outcome:** live since 22:26 CET on the second attempt.
Full record: `.nanoclaw-migrations/index.md` §1.12. Standing rules: the "This install — fork
conventions" section of `CLAUDE.md`.

## What was planned

Stages 9 (config) and 10 (validate and cut over) of the intent-based migration. Stages 1–8 had
rebuilt every fork customization on a clean `v2026.10.0` checkout in a worktree, and both suites
were green.

## What validation found before cutover

Green suites hid three "ported but never wired" gaps from earlier stages:

- `watchdog.ts` and `health-server.ts` were copied but never started from `main()`. The unit is
  `Type=notify` with `WatchdogSec=30s`, so systemd would have failed the restart. Wiring them in
  surfaced two more bugs: `/health` serialized a Promise (the snapshot became async in the DbDriver
  port), and a taken port crashed the whole host. Both fixed.
- §6.3 (drop `-v2-` from unit/image names) was never applied. Names would no longer match the
  running `nanoclaw-583cc1c4`.
- The `search_history` container tool was never ported (only the host half was), so the action was
  registered but nothing could call it. Rebuilt on the runner's mailbox port with a fake-host test.

Also: a literal `git merge` of the branch into `main` gave 96 conflicts and would have kept dropped
fork files, so the cutover became a merge commit whose tree equals the branch's.

## The cutover

- **Attempt 1 (21:21), rolled back after about 2½ minutes.** Upstream's upgrade tripwire stopped the
  first start (cleared with `scripts/upgrade-state.ts set`). The second start died with
  `No gateway provider is registered in this build`: stage 1's `/add-onecli` had never been applied,
  and the suites mock the gateway provider. Rolled back to tag `pre-phase2-cutover`, the old image
  and a byte-exact DB.
- **Fix:** applied `/add-onecli` in the worktree, but skipped its gateway setup step because the
  gateway was already on the 1.42.0 pin. Its doc had lost the credential-injection probe, so that
  was put back. Then a **sandbox boot**: the built host from a scratch dir, against a copy of the DB,
  with no channel credentials and an unreachable gateway URL. It selected the `onecli` provider,
  applied exactly the 7 expected migrations, sent `READY=1` / watchdog / `STOPPING=1`, and served
  `/health` 200.
- **Attempt 2 (22:25) succeeded.** One more surprise: upstream's Slack adapter uses Socket Mode
  whenever `SLACK_APP_TOKEN` is set, but this Slack app is webhook-only, so inbound silently vanished.
  Commenting the token out of `.env` fixed it. Then all five checks passed: both gateway health
  endpoints, the injection probe (`injections_applied=1`), and a Slack round-trip.

## After cutover

- Replies were threaded because the fork's §5.5 `reply_mode` was never ported. Replaced it with
  upstream's per-wiring `threads=0` on all 12 Slack channel wirings, and fork-patched
  `SLACK_DEFAULTS` so new wirings are unthreaded too. Trade-off: new channel wirings default to engage
  mode `mention`, because mention-sticky needs threads.
- Restored the fork conventions to `CLAUDE.md` (re-checked against the new code) and recorded the
  outcome in the migration plan, now marked closed.

## /done wrap-up

- CI on `main` had failed since the cutover. `skill-pins` was stale after stage 7's Gmail/GCal MCP
  pins; regenerated. "Registry skills" is an upstream-only workflow (it needs upstream's `channels`
  branch), so it was disabled on the fork.
- ESLint: fixed the `/health` handler's misused promise and an unused Slack import. The 7 remaining
  errors are in payload-installed files (`whatsapp.ts`, `onecli-files.ts`), left alone so they stay
  identical to their skills. CI does not run ESLint.
- `.gitignore` now covers `*.pem`, `*.key` and `credentials.json`.
- This `journal/` was restored: the tree swap had dropped the five earlier entries, recovered here
  from `pre-phase2-cutover`.

## Lessons

1. Green tests don't prove the host boots. Before a cutover, boot the built artifact against a copy
   of real state, isolated from live.
2. "Ported" isn't "wired". Check that each ported module has a caller, not just that it compiles.
3. Every commit on the live checkout needs a fresh upgrade stamp before the next restart.
4. `logs/nanoclaw.log` lines have no dates. Anchor on the last `NanoClaw starting` line, not on a
   time of day.

## Open follow-ups

- Around 2026-11-12: delete the `:pre-phase2` image and the worktree if nothing has regressed.
- Re-link WhatsApp (`store/auth/` is empty; this predates the cutover).
- Retroactive key-leak scan of `logs/setup*.log`.
- Optional: Slack Socket Mode (turn it on in the Slack app first).
