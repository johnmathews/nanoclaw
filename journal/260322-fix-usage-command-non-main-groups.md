# Fix /usage command in non-main groups

**Date:** 2026-03-22

## Bug

`/usage` (and other read-only intercepted commands) silently failed in non-main Slack channels like #server-bot.
The command was detected and the cursor advanced, but no response was sent.

## Root cause

Two code paths handle intercepted commands:

1. **Recovery/`handleSessionCommand`** in `session-commands.ts` — correctly skips auth for `READ_ONLY_COMMANDS`
2. **Inline poll loop** in `index.ts` — only checked `isSessionCommandAllowed` (main group or admin), ignoring
   the read-only exemption

Path 2 is the normal path for messages arriving during the poll loop. The auth check failed for non-main, non-admin
senders, the command was silently dropped, and the cursor advanced past it.

## Fix

Exported `isReadOnlyCommand()` from `session-commands.ts` and added it as an `||` condition before
`isSessionCommandAllowed` in the inline path. Read-only commands now execute for any sender in any group,
matching the behavior already implemented in `handleSessionCommand`.

## Lesson

When the same authorization logic exists in two code paths, a change to one path (adding `READ_ONLY_COMMANDS` to
`handleSessionCommand`) must be mirrored in the other (the inline poll loop in `index.ts`). The inline path was
easy to miss because it's deep in the message loop, not in the session-commands module.
