# WhatsApp: fix attachment path + stop wiping creds on every restart

Date: 2026-05-26. Tags: fix, bug, whatsapp, multimodal.

The user noticed two compounding WhatsApp problems while testing the
multimodal port from earlier today. The first surfaced as "WhatsApp stopped
working" and turned out to be three distinct bugs stacked on top of each
other, not one.

## The presenting symptoms

1. WhatsApp channel had silently stopped responding overnight.
2. After re-pairing, the agent acknowledged inbound images and voice notes
   with "the file path is referenced but the file isn't accessible from my
   workspace."

The two symptoms looked unrelated; they were not.

## Root cause #1 — adapter wrote attachments to a path the container couldn't see

`src/channels/whatsapp.ts:455` was writing inbound media to
`<projectRoot>/data/attachments/<filename>` on the host and stamping
`att.localPath = "attachments/<filename>"`. The formatter then told the
agent "the file is at `/workspace/attachments/<filename>`" — which doesn't
exist inside the container, because the container only mounts the
per-session dir at `/workspace`. `data/attachments/` was never mounted.

The Chat SDK bridge (Slack, Discord, etc.) handles this correctly: set
`att.data = <base64>` on the attachment entry, no file written by the
adapter, and let `extractAttachmentFiles` in `session-manager.ts:270` spill
to `<sessionDir>/inbox/<messageId>/<filename>`. The spill code runs
unconditionally on every inbound message — the WA native adapter just
wasn't using it.

**Fix:** rewrote `downloadInboundMedia` to follow the same base64+spill
pattern. As a free bonus, wired the existing `maybeTranscribe` (Whisper)
and `maybePdfExtract` (`pdftotext`) helpers — both exported from
`chat-sdk-bridge.ts` and previously only used by Slack — so voice notes
now come through as inline transcribed text and PDFs as extracted text,
not just opaque bytes the agent can't decode.

`downloadInboundMedia` lifted out of the per-adapter closure to module
level and exported, with the Baileys downloader injectable so the unit
tests don't need to mock the whole `@whiskeysockets/baileys` surface.

## Root cause #2 — disconnect handler wiped creds on every graceful shutdown

While re-pairing to test multimodal, the new creds got wiped on the very
next `systemctl restart`. Looking at the disconnect handler:

```ts
const shouldReconnect = !shuttingDown && reason !== DisconnectReason.loggedOut;

if (shouldReconnect) { /* reconnect */ }
else { /* wipe auth, log "WhatsApp logged out" */ }
```

That `else` collapsed two cases that should be distinct: genuine logout
(reason 401) and graceful shutdown (`shuttingDown=true`, `reason=undefined`).
On every shutdown, the adapter wiped its own credentials and logged "logged
out" — the user had no way to tell this from a real server-side logout.

This is why "WhatsApp stopped working" appeared overnight too. It wasn't a
server-side logout (the `440 connection replaced` an hour before was just
a transient and the adapter handled it fine). It was the host process
restarting for an unrelated reason and the adapter eating its own state on
the way down. Every restart since this code was written has been wiping
creds; we just noticed when the next restart didn't happen quickly.

**Fix:** extracted the decision to a pure `classifyConnectionClose(reason,
shuttingDown)` returning `'reconnect' | 'wipe' | 'preserve'`. Only
`reason === loggedOut` returns `'wipe'`; shutdown without a logout returns
`'preserve'`. Unit tests cover the matrix so the regression can't quietly
return.

## Root cause #3 — stale dist drift (separate, earlier in the morning)

Before the WA work I noticed `dist/channels/index.js` only imported `cli`
while `src/channels/index.ts` imported `cli + whatsapp + slack + resend`.
A build at 00:20 last night ran from an older state of the barrel; src was
edited 7 min later and never recompiled. The running process kept working
all evening from its in-memory module graph — the failure only surfaced
when the service was restarted today. Documented separately in memory.

## What landed

- `src/channels/whatsapp.ts` — refactored `downloadInboundMedia` (lifted
  to module level, exported, base64+spill+transcribe+extract path);
  extracted `classifyConnectionClose`; rewired the disconnect handler to
  use it.
- `src/channels/whatsapp.test.ts` — new file, 11 tests covering attachment
  shape, mime fallback, unsafe filename rejection, downloader-error
  resilience, transcription/extract dispatch, and all four
  `classifyConnectionClose` cases.

482 tests pass (was 471 before this session). Lint surface for the file
unchanged from baseline (project-wide `no-catch-all` style warnings, no
new errors).

## Verified end to end on real WhatsApp traffic

User sent a real image and three voice notes after the rebuild:

- Image (`105 KB`, `image/jpeg`) → landed at
  `data/v2-sessions/.../inbox/<msgId>/image-...jpg`, container spawned,
  multimodal block delivered.
- Voice notes (`14 KB`, `5.8 KB`, `5.5 KB`, all `audio/ogg; codecs=opus`)
  → Whisper transcribed inline (confirmed via `inbound.db`:
  `"transcription": "And can you also hear what I'm saying to you now?..."`)
- Service was restarted twice during the session post-fix; auth dir
  preserved both times. No re-pairing needed.

## What I'd watch for next

- The wipe-on-shutdown bug means anyone who restarted nanoclaw on a host
  with limited WA re-link allowance may have burned themselves on the rate
  limit. Worth a release-notes mention rather than a silent fix.
- The 12 pre-existing lint errors in other files (`circuit-breaker.test.ts`,
  `cli/*`, `container-runner.ts`, etc.) are out of scope here, but they're
  real `no-unused-vars` errors that should get cleared at some point.
