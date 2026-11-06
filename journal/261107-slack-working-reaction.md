# 1. Slack: 👀 while the agent works, and two mute channels

**Date:** 2026-11-06 into 2026-11-07. **Outcome:** in unthreaded Slack chats the bot puts 👀 on
the user's message while it works and removes it when the reply lands. HackerNews and
job-search-ritsya answer again; the FT and HackerNews digests are back on schedule.

## 1.1 Channels that looked broken after the upgrade

- **Mute agents.** Since v2026.10.0 an agent with no `agent_destinations` row can't send at all,
  not even to the chat it was asked in: the runner tells it "You cannot send messages until an
  admin wires one up". HackerNews Summaries and job-search-ritsya never had a row, which the old
  runner tolerated. Added one each (named after the channel). Rejected the agent's own pending
  request for a `slack` destination.
- **Digests paused since 2026-08-23.** FT, HackerNews and the morning report were all paused that
  day. I couldn't find what paused them, but it was 2½ months before the upgrade. FT (08:00, every other day)
  and HackerNews (09:00) were resumed with their next run set to the following morning. The morning
  report stays paused. Deleted a duplicate HN task the agent created while trying to help.
- **Paywall extension gone.** `/srv/apps/syncthing/all/bypass-paywalls-chrome-clean-master` no
  longer exists (Syncthing was removed from this host), so the FT and HN mounts were rejected at
  every spawn. Removed the mount and `AGENT_BROWSER_EXTENSIONS` from both.
- Not the upgrade: the agent-requested 👀 via `add_reaction` fails with `message_not_found`
  because the stored inbound id is `<ts>:<agent group>` (`messageIdForAgent` in `src/router.ts`).
  It's an upstream bug dating from April.

## 1.2 Why a reaction and not a status line or an ephemeral message

- The host's typing module calls `assistant.threads.setStatus`, which needs a thread. Unthreaded
  wirings pass `threadId=null`, so the adapter skipped it silently ("no thread context").
- Tested live: `setStatus` with a top-level message ts as `thread_ts` returns `ok:true` and
  renders nothing, in the channel or the thread.
- `chat.postEphemeral` can't be edited or deleted, so every answer would leave a "thinking…" line.

## 1.3 What changed

- `src/modules/typing/`: the refresher remembers the inbound message id and calls the adapter's
  optional `markWorking` once per message. It calls `clearWorking` when a reply is delivered, when
  a newer message arrives (the marker moves), on container exit, and when the agent goes idle. A
  message that was answered is never re-marked.
- `src/delivery.ts`: `isUserVisibleReply` decides which delivered rows clear the marker. The
  agent's own reactions and edits don't.
- `src/channels/chat-sdk-bridge.ts`: opt-in `workingReaction` config. It only acts when
  `threadId` is null and the id passes `isMarkable`. A `WorkingReactionEchoGuard` drops the
  platform's echo of the bot's own 👀 for 60s, so it can't be routed to an agent as a user reaction
  even if chat-sdk's `isMe` check doesn't know the bot id.
- `src/channels/slack.ts` (also on `origin/channels`, convention #11):
  `workingReaction: { emoji: 'eyes', isMarkable: isSlackMessageTs }`.
- Tests: typing marker lifecycle, the reply check, bridge add/remove and the echo drop through the
  real Chat SDK dispatch (verified to fail with the guard disabled), and Slack guard cases in
  `slack-fork.test.ts` (verified to fail against the unpatched `slack.ts`).
