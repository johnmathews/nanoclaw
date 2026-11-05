# Integrate upstream cherry-picks + merge silent-turn, then deploy to prod

**Date:** 2026-06-28

## What happened

Brought a curated set of upstream changes into the fork, folded in the fork's own
in-flight silent-turn work, and deployed the lot to prod. Three streams of change landed
on `main`, then the host was rebuilt and restarted.

## 1. Budget/billing error delivery (upstream `01433bae` → `b7c6f143`)

A turn that ends in a non-retryable provider error (e.g. an Anthropic `403 billing_error`)
comes back from the SDK as a `result` with `is_error=true` and no `<message>` envelope.
The old poll loop treated that as scratchpad and dropped it, then pushed a re-wrap nudge →
new turn → same error, re-hammering the gateway until idle-kill. The user saw silence.

The fix surfaces `is_error` on the result event (`providers/claude.ts`, falling back to
`errors[]` for the text), and in `poll-loop.ts` delivers the notice verbatim to the
originating channel while skipping the nudge.

Cherry-pick hit a **CHANGELOG-only** conflict (both fork and upstream added a bullet to
the top of `[Unreleased]`) — resolved keep-both, no code touched.

## 2. A2A per-message approval policies (15 upstream commits, `8cb499e4..3ed392e2`)

An optional, directed, per-message require-approval gate on existing A→B agent
connections. New `policies` CLI resource, `message-gate`, `agent-message-policies` DB
layer, and two **module migrations** (`module-agent-message-policies`,
`module-approvals-approver`). Cherry-picked clean (zero conflicts), fast-forwarded onto
`main`.

## 3. Silent-turn recovery merged into `main` (`9253c9d1`, `36e6b4f4`)

The fork's `fix/silent-turn-recovery` branch (auto-recover empty/`<internal>`-only chat
turns + a hardened nudge) had branched off the *old* main, so its 2 commits had to be
cherry-picked onto the new main — which conflicted with the budget fix above, since both
rewrite the same "this turn delivered nothing — now what?" block in `poll-loop.ts`.

### Reconciliation

The two fixes now coexist with **error-notice taking precedence**:

- An error turn delivers via `deliverErrorResult` → `writeMessageOut`, which **bumps the
  process-wide outbound counter**. So by the time the silent-turn check runs,
  `deliveredThisTurn > 0` and `silentTurn` is false — the silent nudge can't fire on an
  error turn. No extra guard needed; the counter does it.
- Collapsed the budget fix's inline `archivePrompts.shift()` (error branch) and its
  empty-text `else { shift }` into the **single unified tail**
  `if (!willRetryWrapping && !silentTurn) archivePrompts.shift()` — avoiding a double-shift.
- Empty turns now fall through to the silent-turn check (silent-turn's intent) instead of
  the budget fix's old empty-text branch.
- Updated the 2 budget tests to the new 9-arg `processQuery` signature (`…, false, false`);
  behavior-identical. (`bun test` doesn't type-check, which is why the original 7-arg calls
  ran on main — the new 9th param `initialExpectsReply` is required, so the calls needed
  fixing for `tsc`.)

Caught and fixed one self-inflicted issue: the first test-file edit left a stray `>>>>>>>`
marker that `cherry-pick --continue` committed (it doesn't re-scan); removed it and
`--amend`ed.

Validation: container `tsc` clean, `poll-loop.test.ts` 37/37 (budget + silent-turn +
existing), full agent-runner 156 pass / 1 pre-existing flaky timeout, host 750/750.

## Deploy

Service is a systemd user unit `nanoclaw-583cc1c4` running `node dist/index.js`; the
agent-runner source is **bind-mounted** from the working tree (no image rebuild needed for
agent-runner changes — they apply on container cold-start). A2A is host-side and adds DB
migrations that run on boot.

Pre-flight confirmed the upgrade-marker tripwire was safe (code version `2.1.16` ==
recorded `2.1.16`), and no host/agent-runner dep changes (no `pnpm install`, no image
rebuild). Sequence: stash docs WIP → checkout `main` → `pnpm run build` → back up
`data/v2.db` → `systemctl --user restart nanoclaw-583cc1c4`.

Boot was clean: `Running migrations count=2` → both applied →
`agent_message_policies` table created, `pending_approvals.approver_user_id` added,
`schema_version` → 22 → `NanoClaw running`, health server up, `NRestarts=0`.

## Cleanup

- Deleted staging branches `pick/agent-runner-budget-errors` + `pick/a2a-approval-policies`
  (local + remote) after confirming both fully represented in `main` via patch-id.
- Removed a stray empty `inbound.db` from the repo root (a 0-byte SQLite artifact created
  by running something with a relative path; real session DBs live under `data/`, already
  ignored) and added `/inbound.db` + `/outbound.db` to `.gitignore` to stop recurrence.
- Kept `fix/silent-turn-recovery` and its uncommitted docs WIP (in `stash@{0}`), plus the
  `data/v2.db.bak-predeploy-20260628` safety backup.

## Notes for next time

- The working tree at `/srv/apps/nanoclaw` must stay on `main` for the deploy to remain
  coherent — the agent-runner bind-mount serves whatever branch is checked out.
- Upstream security issue #2828 (A2A attachment forwarding follows a symlinked inbox) is
  still **watch-only** — no fix yet, and we just expanded the A2A surface, so keep an eye
  on it.
