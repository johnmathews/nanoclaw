# Fix agent-runner duplicate model property

**Date:** 2026-04-09

## Problem

The journal-insights-app Slack channel stopped responding to messages. Every container spawn for the `journal` group
exited immediately with code 2, and the message cursor rolled back on each failure, creating an infinite retry loop
(containers spawning every ~10-15 seconds).

## Root Cause

`container/agent-runner/src/index.ts` had `model: sdkModel` listed twice in the same object literal passed to the
SDK's `query()` function (lines 356 and 363). TypeScript strict mode rejects duplicate properties (TS1117), so the
agent-runner failed to compile at container startup.

This was likely introduced during the recent reply/quoted message context commit (`ca8c6bc`) which modified code
around that area.

## Fix

Removed the duplicate `model: sdkModel` on line 363. The first occurrence at line 356 is correct and sufficient.

Since the agent-runner source is synced from `container/agent-runner/src/` to the container on every spawn (no
container rebuild needed), the fix takes effect immediately on the next message.

## Impact

All channels share the same agent-runner source, so every group would have failed if triggered. Only the journal
group was actively being used, so only it exhibited the crash loop.

## Lesson

The agent-runner TypeScript isn't covered by the host's `npm test` or `npm run build` because it lives in
`container/agent-runner/` with its own `tsconfig.json`. A compilation error there is only caught at container
runtime. Consider adding a CI step that runs `tsc --noEmit` against the agent-runner source.
