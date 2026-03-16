---
date: 2026-03-16
tags: [concept]
---

# Groups and the Main Channel

## What

Clarified the meaning of "groups" in NanoClaw and the special role of the main channel.

## Groups

A _group_ is any registered chat that Andy participates in — regardless of platform. This includes WhatsApp groups,
Telegram groups, Discord servers, Slack channels, and 1-on-1 personal chats. The word "group" is used loosely to mean any
conversation Andy is connected to.

The platform itself is referred to as the _channel_ (e.g. WhatsApp, Telegram). Folder names reflect this with a channel
prefix: `whatsapp_family-chat`, `telegram_dev-team`, etc.

Each group has its own folder under `groups/` for memory files, and is registered in the `registered_groups` table in the
SQLite database with a JID, name, folder, and trigger word.

### Trigger behavior

By default, users must @mention Andy (e.g. `@Andy`) to get a response in a group. This can be disabled for solo/personal
chats where all messages should be processed.

## The Main Channel

The main channel is a special group with `isMain: true`. It has elevated privileges:

- _No trigger needed_ — all messages are processed automatically, no @mention required
- _Admin capabilities_ — registering/removing groups, configuring allowlists, scheduling tasks for other groups, managing
  global memory
- _Control center_ — intended for the owner/admin, not general users

It's the backstage interface for managing the whole Andy setup.

## Sessions

Each incoming message spins up a fresh Docker container (`docker run --rm`), but conversation continuity is preserved via
a session ID stored in the database. The session ID is passed to each new container as a `--resume` flag, so the
conversation feels continuous even though each reply runs in a fresh container.

A session begins when no prior session ID exists for the group, and effectively never ends — the session ID is reused
indefinitely until manually reset or pruned.
