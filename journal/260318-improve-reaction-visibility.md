---
date: 2026-03-18
tags: [feature]
---

# Reaction Visibility: Agent Can Now See and Respond to User Reactions — Mar 18

## Problem

The reactions skill (merged earlier today) enabled storing incoming reactions and sending outgoing reactions, but the
agent was blind to user reactions. When John reacted with a thumbs-up to the agent's message, the agent said "I don't
see any reaction in the conversation context." Reactions were stored in the DB but never surfaced to the agent.

## Root cause

Three gaps in the reaction pipeline:

1. `formatMessages()` only rendered text messages — reactions in the `reactions` table were never included in the XML
   context sent to the container agent
2. Reactions didn't trigger agent invocation — they were passive store-only events, so the agent was never woken up to
   respond to them
3. The agent had no tool to query reaction history — it would have needed raw SQL

## What was done

### Flow 3: Reactions visible in conversation context

- Added `getReactionsForMessages()` batch query to `db.ts` (avoids N+1 queries)
- Modified `formatMessages()` in `router.ts` to accept optional reactions map and annotate messages:
  ```xml
  <message sender="Alice" time="Jan 1, 2:30 PM">great idea
    <reactions>👍 Bob; ❤️ Carol</reactions>
  </message>
  ```
- Wired into both call sites in `index.ts` (`processGroupMessages` and `startMessageLoop`)

### Flow 4: Reactions trigger agent invocation

- Added `InboundReaction` type and `OnInboundReaction` callback to `types.ts`
- Added `onReaction` to `ChannelOpts` in `registry.ts`
- WhatsApp channel now calls `onReaction` callback (with `is_from_me` detection via bot JID comparison)
- `index.ts` callback stores the reaction AND synthesizes a trigger message like
  `[Reacted 👍 to "hello world..."]` for groups that don't require a trigger pattern
- Skips bot's own reactions and reaction removals

### Flow 5: Agent queries reactions on demand

- Added `getReactionsForChat()` to `db.ts` (joins reactions with messages for context)
- Added `writeReactionsSnapshot()` to `container-runner.ts` (writes `current_reactions.json`)
- Added `query_reactions` MCP tool to `ipc-mcp-stdio.ts` with filters (emoji, reactor, message_id)
- Updated `SKILL.md` to document all three capabilities

## Design decisions

- **Reactions in context use XML annotation** rather than separate section — keeps reactions tied to the specific message
  they belong to, which is how humans think about them
- **Synthetic trigger messages** reuse the existing message pipeline rather than adding a new trigger mechanism — simpler,
  no new infrastructure needed
- **Snapshot pattern** for the query tool (same as `current_tasks.json`) rather than request/response IPC — simpler,
  reactions rarely change during a single agent invocation
- **Bot's own reactions filtered** at the callback level using JID comparison (both phone and LID formats)
- **Deterministic synthetic message IDs** (`reaction:{msgId}:{reactorJid}:{timestamp}`) prevent duplicates

## Tests added

- 14 new tests in `db.test.ts` for batch query, message content lookup, and chat reactions
- 8 new tests in `router.test.ts` for reaction annotation (grouping, XML escaping, missing names)
- 6 new tests in `channels/whatsapp.test.ts` for the onReaction callback flow
