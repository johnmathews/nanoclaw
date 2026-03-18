---
date: 2026-03-18
tags: [feature]
---

# WhatsApp Emoji Reactions Added — Mar 18

## Summary

Added emoji reaction support for WhatsApp: receive and store reactions, send reactions from the container agent via MCP
tool, and query reaction history from SQLite.

## What was done

Merged the `skill/reactions` branch from the `whatsapp` remote. This added:

- `scripts/migrate-reactions.ts` — Database migration for `reactions` table
- `src/status-tracker.ts` — Forward-only emoji state machine for message lifecycle signaling
- `src/status-tracker.test.ts` — 26 unit tests for StatusTracker
- `container/skills/reactions/SKILL.md` — Agent-facing documentation for `react_to_message` MCP tool
- Reaction handling in WhatsApp channel, IPC, index, group-queue, and agent-runner

## How it works

- **Receiving:** WhatsApp `messages.reaction` events are captured, stored in SQLite `reactions` table
- **Sending:** Agent uses `react_to_message` MCP tool via IPC to send emoji reactions
- **Status tracking:** StatusTracker manages emoji state machine for message lifecycle (e.g. eyes → checkmark)
- **Auth:** Agents can only react in their own group's chat (enforced via IPC auth)
