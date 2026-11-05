# Upstream cherry-pick wave, CI gate restoration, and a `.env`-restart incident

**Date:** 2026-07-14
**Area:** host `src/` + `container/agent-runner/src/` (cherry-picks); test infra; ops/deploy
**PRs merged:** [#734](https://github.com/johnmathews/nanoclaw/pull/734), [#736](https://github.com/johnmathews/nanoclaw/pull/736), [#737](https://github.com/johnmathews/nanoclaw/pull/737), [#738](https://github.com/johnmathews/nanoclaw/pull/738), [#739](https://github.com/johnmathews/nanoclaw/pull/739), [#740](https://github.com/johnmathews/nanoclaw/pull/740), [#741](https://github.com/johnmathews/nanoclaw/pull/741) — plus issue #735 (opened, then closed by #738)

## Goal

Work through the outstanding upstream cherry-pick backlog on the live prod fork
(`/srv/apps/nanoclaw`, origin `johnmathews/nanoclaw`, upstream `nanocoai/nanoclaw`),
finishing the in-flight silent-turn WIP first.

## What shipped

1. **#734 — silent-turn fix (the WIP), finished & merged.** Was code-complete
   but CI-red; see below for why that wasn't the fix's fault.
2. **#736 — `search_history` test deflake.** Three round-trip tests raced the
   handler with a fixed `await sleep(50)`; replaced with poll-until-the-request-
   appears. Genuinely flaky; now deterministic.
3. **#737 — `e8a32207` rate_limit_event.** SDK 0.3.x ships rate limits as a
   top-level `rate_limit_event` message, not a `system` subtype; the old branch
   was dead and dropped quota signals. Added a deterministic regression test
   (stubs the SDK, no timers). Rebase-merged to preserve the upstream patch-id.
4. **#738 — the big one: restored CI as a real gate.** See next section.
5. **#739 — security-adjacent trio** (`fcee39ea` command-gate: `/start` filter +
   remove a fail-open admin check; `102ce80f` a2a `in_reply_to` via outbound.db,
   deleting `current-batch.ts`; `ed9a3e33` mount allowlist honors `readOnly` +
   stops caching parse errors). All three needed conflict resolution against
   fork-diverged files — kept the fork's extra tests/features and merged
   upstream's changes on top.
6. **#740 — `e3b2ffce` async agent-image builds** (`execSync` → awaited
   `execAsync` so the single-threaded host stays responsive during long builds).
   Clean pick.
7. **#741 — approvals UX bundle** (`e8148bc0` reject-with-reason, `2ac78093`
   clearer a2a prompt, `3731e267` structured OneCLI render, `2bce8478` colored
   buttons). All four applied cleanly — no conflicts.

## The 3-week CI outage (#738) — the highlight

Every *code* PR since late June had red CI; the last green run on `main` was a
docs-only commit from 2026-05-22, and the team had been `--admin`-merging past
red (the #2828 fixes are on `main` that way). Two container tests failed
deterministically in the full `bun test` run but passed in isolation.

**Root cause:** `upload-trace.test.ts`'s local `runPollLoopWithTimeout` helper
called `runPollLoop({...})` **without `signal`** — unlike the identical helper
in `integration.test.ts`. Without the signal, `runPollLoop`'s
`config.signal?.aborted` check never fires, so `controller.abort()` only settled
the wrapping `Promise.race` while the underlying loop **ran forever**, polling
the shared global session DB into every later test file, stealing their pending
messages (`markProcessing`) and throwing `unable to open database file` after
`closeSessionDb()`. Exactly what the `PollLoopConfig.signal` doc comment warns
about.

**Fix:** one line — thread `signal` through. No production change (prod never
passes a signal). Verified with 16 consecutive green full-suite runs.

**What made it tractable:** treating the "flakiness" as *deterministic
cross-file pollution* and bisecting with explicit file args
(`bun test upload-trace.test.ts integration.test.ts poll-loop.test.ts`
reproduced; each file alone passed). Two tempting-but-wrong fixes were tried and
rejected first: an abortable-`sleep` change to prod `poll-loop.ts` (did nothing —
the leak was a *missing* signal, not slow teardown) and rewriting the test helper
to await real teardown (made it worse). Documented in
`docs/operational-gotchas.md` item 34.

After #738, the remaining PRs (#740, #741, and the earlier ones re-checked)
merged **green on their own merit** — normal squash/rebase, no `--admin`.

## The `.env`-restart incident (ops)

Restarting the host service to deploy the merged host changes (host runs
compiled `dist/`) dropped the **Slack** adapter and produced 766 **OneCLI 401s**.
Root cause was *not* the deploy: `.env` had been **truncated and chowned to
`root:600` on 2026-07-12**, losing `SLACK_SIGNING_SECRET`, `ONECLI_URL`,
`ONECLI_API_KEY`. The 11-day-old process held them in memory; the restart was
the first to read the stripped file — a latent landmine any reboot would have hit.

Recovery without the (available but lossy) LXC rollback: chowned `.env` back to
`john`, reconstructed `ONECLI_URL=http://172.17.0.1:10254` (local OneCLI proxy,
needs no key — so the 401s were just the SDK defaulting to cloud), and John
restored `SLACK_SIGNING_SECRET` from the Slack app settings. One restart brought
Slack + WhatsApp + CLI all back, 0 new 401s. A key diff (`readEnvFile` keys vs
`.env`) confirmed only those two keys actually mattered for this install.
Full write-up + a pre-restart checklist are in `docs/operational-gotchas.md`
item 35.

**Lesson:** don't restart the live host for non-urgent changes without first
verifying `.env` is complete and `john`-readable.

## Notes / follow-ups

- Cherry-picks that needed conflict resolution (`fcee39ea`, `102ce80f`,
  `ed9a3e33`) have patch-ids that differ from upstream, so they will read as
  **false positives** in future `git log --cherry-pick` checks (each carries its
  upstream SHA in a `cherry picked from` trailer). Clean picks (`e8a32207`,
  `e3b2ffce`, and the four approvals commits) track correctly.
- Still uncollected / deferred: `411f5e71` (templates), the judgment-call
  features (`b0c76ce4` tasks control plane, `c2e5b14b` timestamps, `763a3f75`
  ncl args, PR1–12 channel-defaults), and the BREAKING slack/whatsapp-formatting
  skill-move recovery (only matters before a full upstream *merge*).
