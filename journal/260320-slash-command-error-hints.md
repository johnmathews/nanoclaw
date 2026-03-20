# Helpful error for unknown slash commands

**Date:** 2026-03-20

## Problem

With generic slash command forwarding (added 260319), any `\word` from a channel gets sent to the SDK. When the SDK
doesn't recognize a command (e.g. `\skills`), it returns "Unknown skill: skills" — unhelpful because the user has no
idea what commands ARE available.

## Solution

The SDK's `system/init` message includes a `slash_commands: string[]` array listing all recognized commands. The
agent-runner already processes init messages for session ID tracking. We now also capture the available commands list and
append it to error responses.

Example output after the change:
```
Unknown skill: skills

Available commands: /compact, /clear, /done, /usage, /cost
```

## Implementation

- Extracted `formatSlashCommandError()` into `container/agent-runner/src/utils.ts` for testability
- Captured `slash_commands` from the init message in the slash command handling path
- Applied the formatter in the error result handler
- Added 3 unit tests covering: no commands available, commands appended, fallback error text

Agent-runner only change — no host-side modifications. Takes effect on next agent invocation via the source mount
mechanism (no container rebuild needed).
