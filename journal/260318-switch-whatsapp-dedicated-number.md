---
date: 2026-03-18
tags: [decision, ops]
---

# Switch WhatsApp to Dedicated Agent Number — Mar 18

## Summary

Switched from shared-number self-chat to a dedicated WhatsApp number for the agent. The agent now has its own WhatsApp
Business account on a separate eSIM, so chatting with it looks like a normal 1-on-1 conversation.

## Why

The self-chat model (sending messages to yourself, prefixed with `agent:`) was confusing — you couldn't visually
distinguish who said what. A dedicated number gives a proper two-party chat where each side's messages appear naturally.

## What was done

1. Registered a second phone number (+31 6 44710812, Simyo eSIM) on WhatsApp Business
2. Linked WhatsApp Business to NanoClaw via pairing code (`npm run auth --pairing-code --phone`)
3. Set `ASSISTANT_HAS_OWN_NUMBER=true` in `.env`
4. Re-registered the `whatsapp_main` group with JID `31683775990@s.whatsapp.net` (John's personal number as seen from
   the agent's account)
5. Backed up old auth to `store/auth-personal-backup/`

## How `ASSISTANT_HAS_OWN_NUMBER` works

- **`false` (old):** One number for both user and bot. Bot messages prefixed with `agent:` to distinguish them.
  `isBotMessage` checks for the prefix.
- **`true` (new):** Separate number. No prefix needed. `isBotMessage` uses the `fromMe` flag since only the bot sends
  from its own number. Messages are cleaner.

## Auth notes

- QR code scanning from Claude Code terminal didn't work well (rendering issues). Pairing code method
  (`--pairing-code --phone <number>`) is much more reliable for headless/terminal setups.
- WhatsApp Business can coexist with regular WhatsApp on the same iPhone (one per number).
