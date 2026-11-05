# Fix: WhatsApp replies stalled until the next inbound message

**Date:** 2026-06-22 (follow-up to `260622-fix-silent-message-loss-delivery.md`)

## Symptom

On WhatsApp: ask the agent something, watch the typing (`…`) indicator come and
go — and then *nothing arrives*. A minute or so later, sending any message (even
a single `?`) makes the original reply appear **immediately**. Started right after
the silent-loss delivery fix (`ef38c0f4`) shipped and the host restarted.

## Root cause

`ef38c0f4` deleted WhatsApp's in-memory `outgoingQueue` + `flushOutgoingQueue`.
That queue was lossy (in-memory, dropped on restart) and rightly removed — but it
was also the **only delivery trigger that fired on socket reconnect**: the `'open'`
handler called `flushOutgoingQueue()`, pushing anything composed during the gap
within ~1–2s, independent of the host poll and the container lifecycle.

WhatsApp re-opens its socket ~150×/day (per the silent-loss journal). After the
removal, a reply that couldn't send immediately — composed during a reconnect gap,
or against a **zombie socket** (`connection==='open'`, so `connected` is true, but
the server has stopped acking and `sock.sendMessage` hangs) — was handed to the
host's poll-based re-drive. But delivery is poll-driven (`src/delivery.ts`):

- 1s **active** poll → sessions with `container_status IN ('running','idle')`
- 60s **sweep** → all `status='active'` sessions

The moment the agent's turn ends, the container idles/stops and the session leaves
the fast poll, so the deferred reply waited for the 60s sweep. In practice the user
poked the chat first; that inbound re-woke the container (`container_status → running`),
the session re-entered the 1s poll, and the reply flushed within seconds — looking
like the poke *caused* the send.

Confirmed in the live log: WhatsApp deliveries landed ~5s **after an inbound**,
never spontaneously between them. Notably there were **zero** `"Message delivery
deferred"` warnings — the stall wasn't even the clean defer path; sends were either
un-polled off-container or silently hung on a zombie socket.

## Fix

Three independent mechanisms, all keeping today's correctness win (no false
"delivered"):

1. **Re-drive on reconnect.** New optional `ChannelSetup.onReconnect` hook
   (`src/channels/adapter.ts`). WhatsApp fires it on every socket re-open *after
   the first* (`everConnected` guard); the host's implementation (`src/index.ts`)
   calls `redriveActiveSessionsNow()` (`src/delivery.ts`), which drains every
   active session immediately. Restores flush-on-reconnect non-lossily — the
   messages live in the host's deferred table, not in memory.

2. **Decouple re-drive from container state.** `pendingRedrive` map
   (`src/delivery.ts`): a drain that leaves anything non-terminal (deferred in
   backoff, or scheduled for a transient retry) keeps the session on the 1s active
   poll even after its container goes idle/stopped. Computed from a `resolved` set
   of terminal IDs so a message that defers-then-delivers in the same drain clears
   correctly; cleared when nothing pending remains, so the set can't grow unbounded.

3. **Send timeout.** `sendViaSocket` (`src/channels/whatsapp.ts`) wraps
   `sock.sendMessage` with a 15s ceiling (`SEND_TIMEOUT_MS`). On timeout it tears
   the stale socket down (forcing a reconnect, which then fires `onReconnect`) and
   throws `ChannelDisconnectedError`, so the host defers + re-drives instead of
   hanging the session's inflight delivery forever. Applied to both text and media
   sends.

## Net effect

- Reconnect gap → reply flushes within ~instantly of the socket re-opening,
  not on the 60s sweep and not on the user's next message.
- Finished-turn session with a pending reply → still re-driven on the 1s poll.
- Zombie socket → 15s timeout heals it (reconnect) and re-drives the message,
  instead of an indefinite silent stall.

## Wrap-up notes

- Added 2 delivery tests (off-container `pendingRedrive` bookkeeping;
  `redriveActiveSessionsNow` flushing a deferred message on reconnect). Full
  suite: **742 passed**.
- Docs: `CHANGELOG.md` entry; `docs/operational-gotchas.md` §31 (new Delivery
  section).
- Host-only change — takes effect on host restart.
