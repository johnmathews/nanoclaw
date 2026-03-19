# isMain DB regression fix and test hardening

## The bug

Session commands (`\usage`, `\done`, etc.) from Slack's main-group channel were denied with
"Session commands require admin access." The `isMain` flag on `RegisteredGroup` was always
`undefined` because the `is_main` DB column had been silently dropped.

## Root cause

The `is_main` column was added in commit `0210aa9` (multi-channel architecture refactor, Mar 3)
but removed in commit `a23e372` (reactions skill merge, Mar 8). The reactions skill branch was
forked before the column existed, and during merge conflict resolution on `src/db.ts`, the
branch's older version won — silently dropping the column, migration, and all field mappings.

## Fix

- Added `is_main` column migration back to `db.ts` with backfill (`folder = 'main'`)
- Wired `isMain` through `getRegisteredGroup()`, `getAllRegisteredGroups()`, `setRegisteredGroup()`
- Added round-trip tests for all `RegisteredGroup` fields to prevent future regressions

## Test hardening

Went from 532 to 601+ tests. Key additions:

- **DB registered group round-trips** (8 tests) — every field that is stored and loaded has a
  test proving the round-trip works
- **Slack :eyes: reaction lifecycle** (13 tests) — add on typing start, remove on stop, auto-remove
  on sendMessage, per-channel tracking, error handling
- **WhatsApp setTyping** (3 tests) — composing/paused presence, error resilience
- **WhatsApp sendReaction/reactToLatestMessage** (7 tests) — full lifecycle, disconnected state,
  error propagation
- **WhatsApp reaction receiving** (5 tests) — onReaction callback, storeReaction fallback,
  status@broadcast ignored, unregistered groups ignored, bot self-detection
- **WhatsApp own-number mode** (2 tests) — message prefix behavior
- **Container-runner** (13 tests) — multi-output streaming, progress markers, error codes, session
  tracking, timeout reset, malformed JSON, truncation
- **Agent-runner** (40 tests, new suite) — extracted pure functions into `utils.ts` for testability:
  sanitizeFilename, parseTranscript, formatTranscriptMarkdown, writeOutput, writeProgress

## Process change

Added "Merging Skill Branches" section to CLAUDE.md: always rebase skill branches onto current
main before merging. Run tests after every merge. This prevents merge conflicts from silently
dropping code in shared files like `db.ts`.
