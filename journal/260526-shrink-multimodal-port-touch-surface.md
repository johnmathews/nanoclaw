# Shrink the multimodal/reactions port touch surface against upstream

Date: 2026-05-26. Tags: decision, fix.

The W4.x multimodal + chat-reactions port (commit `0888c7f`, originally
landed 2026-05-22) added image/voice/PDF handling and a `query_reactions`
MCP tool. The behavior is good — but the way it was wired touched six
files that upstream actively edits, leaving the fork prone to merge
conflicts on every `update-nanoclaw` cycle.

Two refactors landed in this session to shrink that surface without
changing any behavior or losing any capability.

## Why

Quick measurement before and after, against `upstream/main`:

| File                                | Before | After |
|-------------------------------------|-------:|------:|
| `providers/mock.ts`                 |   +13  |   0   |
| `mcp-tools/core.ts`                 |  +108  |   0   |
| `providers/types.ts`                |   +44  |  +47  |
| `poll-loop.ts`                      |   +31  |  +31  |
| `providers/claude.ts`               |   +30  |  +30  |
| `formatter.ts`                      |   +30  |  +30  |
| **Total (the six hot files)**       | **+256/-6** | **+138/-4** |

Two files (`mock.ts`, `core.ts`) went to **byte-identical with upstream**.
That's the more valuable outcome than the absolute line count: every
future upstream change to those two files now merges cleanly forever.

## What changed

### Refactor 1 — optional multimodal hooks (`c87dabb`)

- `AgentQuery.pushBlocks?` is now an optional method.
- `AgentProvider.supportsMultimodalContent?` is now an optional boolean.
- `poll-loop.ts` call sites use `query.pushBlocks?.(blocks)` and
  `provider.supportsMultimodalContent ?? false`. The existing capability
  gate (`if (provider.supportsMultimodalContent)`) still runs and coerces
  `undefined` to falsy correctly.
- `mock.ts` drops both fields — it's now identical to upstream. The
  `__BLOCKS__` synthetic-turn helper went with it (no tests used it).

A non-multimodal provider added by upstream now needs zero declarations
from us. Claude still declares both fields and implements `pushBlocks`
exactly as before.

### Refactor 2 — split `query_reactions` into its own module (`bc35a81`)

- New file: `container/agent-runner/src/mcp-tools/reactions.ts` with the
  `queryReactions` tool definition and its own `registerTools(...)` call.
- `mcp-tools/core.ts` reverts to upstream byte-for-byte.
- `mcp-tools/index.ts` gains a single `import './reactions.js'` line.
- `mcp-tools/core.test.ts` import path updated. Tests left in the
  same file (splitting them was out of scope — `core.test.ts` isn't
  one of the six upstream-hot files).

## The merge gotcha

Merging `feat/multimodal-reactions-port` → `main` was non-trivial because
main already had an equivalent (but distinct-hash) multimodal commit
`0888c7f` cherry-picked from the feat branch by an earlier session, and
~40 unrelated commits on top of that.

Five files needed hand-resolved conflicts (`types.ts`, `poll-loop.ts`,
`core.test.ts`, `chat-sdk-bridge.ts`, `chat-sdk-bridge.test.ts`).
Resolution was: take feat-side for my own refactor changes, take HEAD-
side for everything else (newer post-multimodal additions on main like
`buildNcv2Inbound`, exported `maybeTranscribe`/`maybePdfExtract`, the
Slack `send_blocks` test suite).

The non-obvious bit came after the merge committed: `mock.ts` and
`core.ts` were back to their pre-refactor state. The 3-way merge
compares endpoints against the merge base only — it doesn't see commit
chains. From git's view:

- merge base 68448c4: no multimodal additions
- HEAD (main): multimodal additions present (from 0888c7f)
- feat branch: multimodal additions present, then removed (b74d3ef + my refactors)

Feat's *net* diff for those lines vs base is zero. Main's diff vs base
shows the additions. Git took main as the only "real" change and
silently dropped the deletions I'd made on the feat branch. Tests
still passed because both core.ts and reactions.ts were registering
`query_reactions` and the server's `registerTools()` dedupes by name
(it warns on duplicates and skips the second).

Fix: a follow-up commit `1f0cce0` reapplied the two deletions directly
on main. Caught it by running `git diff upstream/main --stat` after the
merge and seeing `core.ts | 108` and `mock.ts | 13` still in the list
when they should have been zero.

This is worth remembering: any future "revert a feature-branch addition
then merge to main" sequence will hit the same trap if the feature
existed on both branches before the revert. The right pattern is
probably to rebase the cleanup onto main and merge with a clean linear
history, not 3-way merge.

## What's left

Refactor 3 from the original plan — extracting the multimodal hook out
of `poll-loop.ts` via a `beforeQueryStart`/`afterFollowUpPush` callback
array — was not attempted. `poll-loop.ts` is still +31 vs upstream. If
the cost of that extraction reads as clean (a small generic hook-
registration delta), it would be worth doing in a future session; if
not, the current state is already a big improvement and refactor 3 can
stay deferred.

## Tests

All 471 host + 127 container tests pass. Container typecheck clean.
Pre-existing lint errors in `usage.ts` / `watchdog.ts` / `webhook-
server.ts` are unrelated to this session.

## Commits

- `b74d3ef` feat(multimodal,reactions): port v1's image/voice/PDF + chat.onReaction to v2 (merged from feat branch — equivalent to existing main commit `0888c7f`)
- `c87dabb` refactor(agent-runner): make multimodal provider hooks optional
- `bc35a81` refactor(agent-runner): move query_reactions into its own mcp-tools module
- `00febae` Merge branch 'feat/multimodal-reactions-port' into main
- `1f0cce0` refactor(agent-runner): reapply mock.ts + core.ts cleanups lost in merge
