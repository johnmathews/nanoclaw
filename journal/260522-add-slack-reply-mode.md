# Per-channel reply-mode — Slack: thread vs main channel

Date: 2026-05-22. Tags: feature, decision.

Adds `messaging_groups.reply_mode` so each Slack channel can choose whether
the agent replies in the originating thread (default) or in the channel
root. All nine wired Slack channels were flipped to `channel` mode as part
of the rollout.

## Why

In Slack the bridge always reused the inbound `threadId`
(`slack:CHANNEL:THREAD_TS`), so the bot's reply landed as a thread reply
to whatever message woke it. For high-traffic group channels that buries
the reply behind a "view thread" affordance most members never click —
the agent's output becomes invisible to anyone not already subscribed to
that specific thread. The operator wanted the bot's reply to land in the
main channel timeline so the rest of the group sees it.

This is a per-channel preference, not a global one — DM channels and
focused sub-rooms still benefit from threading; only the busy multi-user
rooms wanted channel-root posts.

## Design

Two scope decisions front-loaded before any code (`AskUserQuestion`):

1. **Setting lives on `messaging_groups`, not `messaging_group_agents`.**
   One Slack channel = one reply behavior, applied uniformly across every
   agent wired into it. The wiring-level option (per-agent-per-channel
   override) would have meant a more flexible API for a use case nobody
   has — defer until someone asks.
2. **Two values, not three.** `thread` (default) and `channel`. A third
   `broadcast` mode (Slack's `reply_broadcast=true` — posts in *both* the
   thread and the channel) was considered and dropped: it would have
   needed a Slack-specific flag plumbed through the otherwise-generic
   outbound message contract.

## Implementation

Five touchpoints, all additive:

1. **Schema** — `src/db/migrations/016-reply-mode.ts` adds
   `reply_mode TEXT NOT NULL DEFAULT 'thread'`. Existing rows keep the
   current behavior on upgrade.
2. **Type** — `MessagingGroup.reply_mode?: ReplyMode` in `src/types.ts`,
   optional so fixtures and pre-016 callers compile unchanged.
3. **CRUD** — `src/db/messaging-groups.ts::updateMessagingGroup` accepts
   `reply_mode` in its allowed-update set.
4. **CLI** — `src/cli/resources/messaging-groups.ts` declares the column
   as `updatable` with an enum, which the generic CRUD layer turns into
   `ncl messaging-groups update --id <mg> --reply-mode <thread|channel>`
   automatically. Enum validation is enforced server-side in `crud.ts`.
5. **Delivery** — `src/delivery.ts` looks up `mg.reply_mode` (same lookup
   the destinations-ACL block already does) and, when `'channel'`, passes
   `threadId=null` to `adapter.deliver`. The chat-sdk bridge falls back
   to `platformId` (which for Slack is `slack:CHANNEL_ID` — no thread_ts
   segment), producing a channel-root post.

The cleanest win: no Slack-specific code path. The bridge already
treated `threadId=null` as "post to channel root" for any adapter (it's
the `tid = threadId ?? platformId` fallback at
`src/channels/chat-sdk-bridge.ts:632`). The feature is just "decide when
to set it to null."

Other adapters ignore the column for free: non-threaded adapters
(Telegram, WhatsApp, email) get `threadId=null` zeroed out by the
router before delivery even runs (`router.ts:166`), so re-zeroing it
is a no-op.

## Gotchas worth remembering

- **`ncl messaging-groups update <id>` positional form is broken for any
  mg whose id contains internal dashes** (which is all of them —
  `mg-<timestamp>-<rand>`). The dispatcher's "trim last dash-segment"
  fallback (`dispatch.ts:24-35`) only peels one segment, so
  `messaging-groups-update-mg-1779373702793-p7eo6n` becomes
  `messaging-groups-update-mg-1779373702793` + tail `p7eo6n` — neither
  half is registered. Workaround: always use `--id <mg-...>`. This
  isn't reply-mode-specific; it bites every CRUD verb. Worth a
  multi-segment trim in the dispatcher at some point.
- **`update` is gated `approval` in the resource definition** but host
  callers (Unix-socket transport) bypass approval — only `agent` callers
  go through the approval flow (`dispatch.ts:42`). So `ncl` from the
  shell sets the column directly; agent self-modification would require
  an admin approval.
- **No container restart needed.** `delivery.ts` reads `mg.reply_mode`
  per outbound message from the central DB — flipping the column
  takes effect on the next message in any session.
- **The running service compiles from `dist/`, not source.** First
  attempt at `ncl messaging-groups update ... --reply-mode channel`
  errored with "nothing to update — provide at least one of: --name,
  ..." because the live host's CRUD registration was the pre-edit
  snapshot. Fix: `pnpm run build && systemctl --user restart
  nanoclaw-v2-787facac.service`. Worth noting because tests pass against
  source (vitest runs tsx) — a green test suite doesn't mean the live
  CLI is up to date.

## Rollout

All nine wired Slack channels (`nanoclaw`, `git-maintenance`,
`main-group`, `job-search`, `server-bot`, `docs`, `journal`,
`nederlands`, `The Managers' Guide`) flipped to `channel` mode via a
single `UPDATE` through `scripts/q.ts`. CLAUDE.md sanctions q.ts for
ad-hoc DB writes; the bulk-set-all-Slack-channels intent maps more
naturally to one statement than nine sequential `ncl` invocations.

## Relevant files

- `src/db/migrations/016-reply-mode.ts`
- `src/db/migrations/index.ts`
- `src/db/schema.ts`
- `src/types.ts` (`ReplyMode`, `MessagingGroup.reply_mode`)
- `src/db/messaging-groups.ts`
- `src/cli/resources/messaging-groups.ts`
- `src/delivery.ts` (effective-thread-id override)
- `src/delivery.test.ts` (two new tests covering thread and channel modes)
- `docs/db-central.md`
