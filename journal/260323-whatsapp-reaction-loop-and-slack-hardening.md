# WhatsApp Reaction Loop Fix and Slack Channel Hardening

Date: 2026-03-23

## WhatsApp Reaction Loop Bug

### Problem

A single user reaction on WhatsApp cascaded into 21,330 synthesized reaction messages, causing an infinite loop
that filled the agent's session file to 15MB and permanently deadlocked the session with "prompt is too long".

### Root Cause (two bugs)

**Bug 1: `is_from_me` detection failed in DMs.** In own-number mode, WhatsApp reaction events have
`reaction.key.remoteJid` set to the OTHER person's JID (not the reactor's). The code compared this against the
bot's JID and concluded the bot's own reactions were from the user. Fix: added `reaction.key?.fromMe === true`
check, which is reliable in own-number mode.

**Bug 2: StatusTracker sent emoji reactions on WhatsApp.** The StatusTracker sent progress reactions
(received/thinking/working/done) on user messages. WhatsApp already has native typing indicators via
`sendPresenceUpdate('composing')`, making these redundant. Combined with Bug 1, each StatusTracker reaction
was misidentified as a user reaction, synthesized as a message, and re-triggered the agent.

### Fix

- Added `hasNativeTyping` property to the `Channel` interface. WhatsApp, Telegram, and Slack all set it to `true`.
- StatusTracker skips reactions for channels with native typing indicators.
- Fixed `is_from_me` detection with `reaction.key?.fromMe` check.
- Added host-side session file size safety net: sessions >10MB are cleared before resume.
- Added compact event logging in the agent runner for visibility.

### Recovery

Deleted 21,330 junk messages from the DB and cleared the corrupted 15MB session file. The agent started
fresh on the next message.

## Slack Channel Hardening

### Issues Found and Fixed

1. **Duplicate status reactions**: Slack's `:eyes:` reaction and StatusTracker's emoji reactions both fired on
   the same messages. Set `hasNativeTyping = true` on Slack to prevent StatusTracker from sending redundant
   reactions.

2. **Queue flush didn't split long messages**: `flushOutgoingQueue` sent messages directly without respecting
   Slack's 4000-char limit. Extracted `splitMessage()` as a shared function used by both `sendMessage` and
   `flushOutgoingQueue`.

3. **Queue flush abandoned remaining messages on error**: A single failed message would abort the entire
   flush. Added per-message try/catch; failed messages are re-queued for the next flush attempt.

4. **No periodic channel metadata sync**: Unlike WhatsApp (24h interval), Slack only synced channel names on
   startup. Added a 24-hour sync interval.

5. **Message splitting broke mid-word**: The splitting logic sliced at exact character boundaries. New
   `splitMessage()` function prefers breaking at the last newline, then last space, before the limit. Falls
   back to hard split only when no whitespace is available.

### Test Coverage

Added 12 new tests:
- `splitMessage` unit tests (8): short messages, exact limit, newline splitting, space splitting,
  hard splitting, custom maxLen, empty string, multiple newlines
- `flushOutgoingQueue` tests (3): long message splitting, per-message error resilience, failed message re-queuing
- `hasNativeTyping` property test (1)
