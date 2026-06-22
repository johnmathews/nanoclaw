# Fix: outbound messages silently lost on Slack & WhatsApp

**Date:** 2026-06-22

## Symptom

Occasionally, on both Slack and WhatsApp, the agent would "send" a message that the
user never received. The agent believed it had sent it — and could recall the exact
text when asked — but it never appeared in the app.

## Root cause

The agent "sends" by writing a row to its **`outbound.db`** (`messages_out`). That write
always succeeds, which is why the agent can always recall the text. Whether the message
actually reaches the user is a *separate* host-side step: `src/delivery.ts` polls
`outbound.db` and calls the channel adapter.

The delivery loop treated **any non-throwing return from `deliver()` as proof of
delivery** — but several adapter paths returned `undefined`-as-success without actually
sending:

1. **WhatsApp** (`sendRawMessage`): when the socket was disconnected (the logs showed
   ~150 reconnect cycles) or `sock.sendMessage` threw, it swallowed the error, pushed the
   message onto an **in-memory** `outgoingQueue`, and returned `undefined`. The host
   marked it delivered and cleared the outbox — the only remaining copy was the in-memory
   queue, lost on the next restart (and `flushOutgoingQueue` was itself lossy: `shift()`
   before an un-try/caught `await`).
2. **Registry** (`createChannelDeliveryAdapter`): when the target adapter was offline it
   logged a warning and `return`ed → marked delivered.
3. **Slack** permanent errors (`missing_scope`, `message_not_found`, seen live in the
   logs): these *did* throw, so they hit the retry path, but after 3 quick retries were
   marked `status='failed'` and **never surfaced** to anyone. `getDeliveredIds` also
   returned `failed` rows, so they were never re-driven either.

In every case the agent's outbound row persisted, so it "remembered" sending a message
the user never got.

## Fix

Introduced a delivery-error taxonomy in **`src/channels/delivery-errors.ts`**:

- `ChannelDisconnectedError` — channel offline; message fine, pipe down.
- `PermanentDeliveryError` — can never succeed as-is (bad scope, deleted target, ACL).
- `classifyDeliveryError()` — maps thrown errors to `permanent | disconnected | transient`,
  recognizing known-permanent Slack codes by substring.

**Cardinal rule established:** an adapter's `deliver()` returning normally means the
message reached the platform. An adapter that can't send now **throws**; `undefined` is
reserved for operations that legitimately produce no platform message id (reactions, edits).

Changes:

- **`whatsapp.ts`** — `sendRawMessage` throws `ChannelDisconnectedError` when not
  connected and lets send errors propagate; removed the lossy in-memory queue entirely;
  added a connected-guard to the file-send path.
- **`channel-registry.ts`** — throws `ChannelDisconnectedError` when no adapter is
  registered (was log-and-return).
- **`delivery.ts`** — "no adapter configured" throws `ChannelDisconnectedError`; the
  routing/ACL throws became `PermanentDeliveryError`. The per-message catch now branches:
  - `disconnected` → `markDeliveryDeferred` with exponential backoff (15s→120s); never
    counts against the retry budget, never terminal — re-driven until the channel recovers.
  - `permanent` → `markDeliveryFailed` immediately + surface to the agent.
  - `transient` → 3 immediate retries, then fail + surface.
- **New `delivered.status='deferred'`** plus `attempts` / `next_attempt_at` columns
  (`schema.ts` + lazy `migrateDeliveredTable`). `getDeliveredIds` now returns terminal
  rows only (`delivered`/`failed`); deferred rows are excluded so they survive restarts
  and re-drive. Terminal marks switched to `INSERT OR REPLACE` so a deferred row
  transitions cleanly (no double-send).
- **Surfacing** (`surfaceDeliveryFailure`) — on a terminal failure, writes a context-only
  (`trigger=0`) notice into `messages_in` so the agent learns its message never landed
  without waking a deliver→notify→deliver loop. It rides along on the agent's next real turn.

## Net effect

- WhatsApp reconnect gap → message deferred and re-driven (arrives late, not never).
- Slack `missing_scope` / `message_not_found` → surfaced to the agent instead of vanishing.
- No path marks a message delivered that wasn't actually sent.

Host-only change — takes effect on host restart; existing session DBs auto-migrate on the
next delivery poll.

## Wrap-up notes

- Added 4 delivery tests (offline-defer-then-reconnect, never-burns-budget-while-offline,
  surface-on-permanent, surface-on-exhaustion); updated one registry test that asserted the
  old silent-drop. Full suite: 740 passed.
- Docs: updated `docs/db-session.md` (`delivered` table status model + the new disposition
  table) and added a `CHANGELOG.md` entry.
- CI/CD phase was N/A: `container/Dockerfile` is the locally-built per-session agent image
  (`./container/build.sh`), not a deployable service — no ghcr push is appropriate, and the
  existing CI already runs typecheck/test/format on PRs.
