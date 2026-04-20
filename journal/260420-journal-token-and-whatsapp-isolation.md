---
tags: [feature, fix]
---

# Journal MCP Bearer Auth and WhatsApp Failure Isolation

Date: 2026-04-20

Two unrelated changes shipped together: the journal MCP server now requires a bearer token, and a single
WhatsApp failure no longer takes down the rest of the service.

## Journal MCP Bearer Auth

### What

The journal MCP server at `192.168.2.105:8400` now requires `Authorization: Bearer <jnl_...>` on every
request. Added a new `JOURNAL_API_TOKEN` env var alongside the existing `JOURNAL_MCP_URL`.

### How

- `.env.example` — added the new var.
- `src/container-runner.ts` — added to `containerSecrets` allowlist and the explicit `-e` passthrough
  (env vars are not inherited by containers, each one needs an explicit flag).
- `container/agent-runner/src/index.ts` — when the token is set, attach `headers: { Authorization: 'Bearer ...' }`
  to the journal HTTP MCP server config. Spread conditionally so absence of the token still works for any
  unauthenticated journal deployments.
- `CLAUDE.md` — documented the new var under the conditional MCP servers section.

### Why a separate var

Could have stuffed the token into the URL as `?token=...`, but the MCP HTTP transport supports headers
natively and bearer auth is the conventional pattern. Keeping URL and credential separate also lets us
rotate the token without editing the URL, and avoids leaking the token into logs that print URLs.

## WhatsApp Failure Isolation

### Problem

When the WhatsApp socket failed (no auth state, or `loggedOut` 401 reason), the channel called
`process.exit(0)` or `process.exit(1)` after a 1s delay. This killed the entire NanoClaw process,
including Slack, Gmail, and any scheduled task runners. A WhatsApp re-auth requirement effectively
blocked every other channel from working.

This bit me when WhatsApp got rate-limited and went into a crash-loop (see
`reference_wa_reauth.md`) — the whole service kept restarting and Slack stayed offline for hours.

### Fix

`WhatsAppChannel.connect()` now always settles its returned promise (resolve on first `open`, reject
on `qr` or `loggedOut` *before* a successful open). The `connectInternal` callback was renamed
`onInitialResult` and accepts an optional error.

- QR emitted (no auth): close the socket, reject with `"WhatsApp not authenticated"`. Notification still
  fires on macOS.
- `loggedOut` (401): if `wasConnected` was false, reject the connect promise with `"WhatsApp session
  logged out"`. If it was true (mid-session logout), just log an error and stay disabled — no exit.
- `process.exit()` is gone from this file entirely.

`src/index.ts` wraps each channel's `connect()` in try/catch in the channel-loop. A failing channel
is logged and skipped; surviving channels continue to register. The existing "no channels connected"
guard at the bottom still aborts the process if every channel fails.

### Tests

Three test cases in `src/channels/whatsapp.test.ts` rewritten:

- QR emit → `connect()` rejects, `process.exit` not called, socket `end()` called.
- `loggedOut` after a successful connect → channel disconnects, `process.exit` not called.
- `loggedOut` before any open → `connect()` rejects, `process.exit` not called.

The first test no longer needs fake timers since there's no `setTimeout(exit, 1000)` to fast-forward
through.

### Why not retry on logged-out

A `DisconnectReason.loggedOut` means the credentials were invalidated server-side — reconnecting
with the same auth state would just produce the same 401. Re-auth requires a human running
`/setup` (or `npm run auth --pairing-code --phone <number>`), so the right behaviour is to disable
the channel and surface the error, not loop.

### Memory updated

This pairs with `feedback_sturdiness_priority.md` — the assistant has to keep working when a
single channel breaks. WhatsApp is the most fragile channel by a wide margin; its failures must
not cascade.
