# Robustness and Merge Safety Improvements

An engineering evaluation identified 8 concerns undermining the foundation needed for safely
adding features and merging upstream changes. All 8 were addressed in a single session.

## Changes

### Robustness

1. **Mount security tests** — `src/mount-security.ts` (419 LOC, security-critical) had zero test
   coverage. Added 26 tests covering allowlist loading, mount validation, blocked patterns,
   readonly enforcement, and path traversal prevention. Uses `vi.resetModules()` for cache
   isolation between tests.

2. **Container resource limits** — Added `--memory 2g` and `--cpus 2` flags to `docker run` in
   `buildContainerArgs()`. Configurable via `CONTAINER_MEMORY_LIMIT` and `CONTAINER_CPU_LIMIT`
   env vars. Previously, a runaway agent could exhaust the host with 5 concurrent containers.

3. **Shutdown race fix** — The message loop `while(true)` had no shutdown awareness. Added a
   `stopping` flag set by the SIGTERM/SIGINT handler before `queue.shutdown()`. Loop now checks
   `while (!stopping)`, preventing cursor advancement during shutdown.

4. **Channel disconnect cursor fix** — `lastTimestamp` was advanced immediately after fetching
   messages (before checking if channels were connected). If a channel was disconnected, messages
   were skipped but the cursor moved past them permanently. Now the cursor only advances past
   messages whose channels are connected. Disconnected channel messages stay in the DB for retry.

5. **Orchestrator testability** — Extracted pure logic from `src/index.ts` into
   `src/message-loop.ts`: `groupMessagesByJid()`, `computeSafeCursor()`,
   `shouldSkipForTrigger()`. Added 16 tests. The orchestrator itself remains hard to unit-test
   (heavy side effects), but the extracted logic covers the critical cursor and trigger decisions.

### Merge Safety

6. **DB schema versioning** — Replaced ad-hoc try-catch ALTER TABLE migrations with a numbered
   migration system. Added `schema_version` table, `runMigrations()` function, and 4 versioned
   migrations. Each migration preserves try-catch for idempotency. Future upstream merges can
   now be checked: if the PR's max schema version is behind main's, CI fails.

7. **CI enhancements** — Added push trigger for main branch, `npm run build` step, rebase check
   for `skill/*` branches (rejects merge commits), and schema version comparison on PRs.

8. **Log rotation** — Switched systemd service from `StandardOutput=append:` to
   `StandardOutput=journal`. Logs now managed by journald with automatic rotation. Previous
   approach grew unbounded (~16MB/day).

## Design Decisions

- **Cursor advance after dispatch, not before**: The global cursor (`lastTimestamp`) now only
  advances past messages that have a connected channel. This is a behavioral change — previously
  all messages advanced the cursor regardless. The non-trigger skip path intentionally still
  advances the cursor (those messages are "seen" and left to accumulate as context).

- **Schema versioning is additive**: Existing databases without `schema_version` table are treated
  as version 0. All migrations re-run (safe due to try-catch). No breaking change.

- **Extracted module vs testing index.ts directly**: Chose extraction over heavy mocking because
  the orchestrator has too many side effects to mock cleanly. The extracted pure functions cover
  the logic that matters most (cursor safety, trigger decisions, message grouping).

## Test Impact

611 tests -> 657 tests (+46 new). All passing.
