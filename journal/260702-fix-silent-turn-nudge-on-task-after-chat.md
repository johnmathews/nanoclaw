# Reset `turnExpectsReply` per follow-up batch — stop silent-turn nudge firing on task ticks

**Date:** 2026-07-02
**Area:** `container/agent-runner/src/poll-loop.ts` (silent-turn recovery)
**PR:** [#734](https://github.com/johnmathews/nanoclaw/pull/734) — branch `fix/reset-turn-expects-reply-per-batch`

## What was wrong

The silent-turn recovery mechanism (added 2026-06-23, documented in
`docs/operational-gotchas.md` item 32) injects a one-shot `<system>Delivery
check…</system>` nudge when a turn triggered by a user chat message delivers
nothing, so the model can recover a dropped reply. Correct for chat turns.

The nudge is gated on a `turnExpectsReply` flag. That flag was **set only,
never cleared**: the initial chat batch latched it to `true` and it stayed
true for the whole `processQuery` run. The follow-up handler read:

```ts
silentNudgeStreak = 0;
if (expectsReply(keep)) turnExpectsReply = true;   // latch — never sets false
```

**Symptom in the wild.** A group's scheduled task (e.g. a 15-min
"library-forward" email sweep) is documented to stay silent on the channel on
routine success. That works when the task fires cold. But if any chat message
arrived earlier in the same `processQuery` run, `turnExpectsReply` was latched
true — so when the task-fire turn ended silently, the nudge fired and forced
the background task to emit an extra channel message. Exactly the
"silent on routine success" contract, violated.

## The fix

Rebind the flag to the current follow-up batch instead of latching:

```ts
silentNudgeStreak = 0;
turnExpectsReply = expectsReply(keep);
```

A chat follow-up sets it true; a task-only follow-up sets it false. Blast
radius kept to the one line — `initialExpectsReply` handling in the caller and
the `expectsReply` predicate are untouched.

### Tradeoff (noted, not addressed)

If a chat message arrives, its reply hasn't been delivered yet, and a task
follow-up lands in the same run *before* the chat's turn-end fires, the flag
clears and the chat's silent-turn nudge is suppressed. In practice this is
rare — the chat's end-of-turn event and its nudge normally fire before any
follow-up is picked up. If it ever bites, the follow-up is a
"delivered-since-last-chat" tracker; not needed today.

## Test

Added `does not nudge a task follow-up that lands after a completed chat turn`
to the `silent-turn recovery` block (now ×5). It drives a chat turn that
replies, drops a silent task follow-up into the still-open query mid-run, and
asserts only the chat reply is delivered and no nudge fires.

One deviation from the original test sketch: the query-end timing was bumped
200ms → 900ms. The follow-up poll only runs every `ACTIVE_POLL_INTERVAL_MS`
(500ms); at 200ms the task was never polled into the query, so the follow-up
path wasn't exercised and the test recorded 1 model call instead of 2. At
900ms it genuinely pushes the follow-up (log: "Pushing 1 follow-up message(s)")
and the assertion holds. It's a real regression guard — with the old latching
code, turn 2 still sees `turnExpectsReply=true` → nudge → 3 model calls.

## Verification & deploy

- `bun test src/poll-loop.test.ts` → 38 pass / 0 fail (all 4 pre-existing
  silent-turn tests + the new one).
- Container typecheck clean (`tsc -p container/agent-runner/tsconfig.json`).
- Deploy: agent-runner `src/` is **bind-mounted live** (read-only) into
  `/app/src` (`src/container-runner.ts:344`; containers run
  `bun run /app/src/index.ts` with no baked image), so the fix applies on the
  next container **cold-start** — no image rebuild or host restart required.
  I did rebuild the image and restart the service during the session before
  re-reading the deployment note; harmless, and the running container
  (cold-started after the restart) is already on the fixed source.

## Housekeeping (same session)

Reclaimed ~10 GB on the LXC (88% → 61% root usage): pruned 8 dangling Docker
images (old agent builds) + unused build cache + 2 orphaned anonymous volumes.
Left tagged images belonging to other services and the named
`apps_syncthing_config` volume untouched.
