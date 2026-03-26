# Health Monitoring System

**Date:** 2026-03-26

## What

Added three-level health monitoring to NanoClaw: a `/status` chat command, an HTTP health endpoint
with systemd watchdog integration, and an external smoke test script.

## Level 1: `/status` Command

- Created `src/health.ts` — pure `collectHealth()` function and `formatHealthText()` formatter
- `HealthDeps` interface keeps the module decoupled from the orchestrator's internals
- Added `registerHealthProvider()` callback pattern in `src/host-commands.ts` to give the
  command access to runtime state without changing `executeHostCommand`'s signature
- Added public `getActiveCount()` and `getWaitingCount()` to GroupQueue
- Added `getRecentTaskFailureCount()` query to `src/db.ts`

## Level 2: Watchdog + HTTP

- `src/watchdog.ts` — uses `systemd-notify --pid=<main_pid>` CLI with `NotifyAccess=all`
- Initially tried `dgram` Unix sockets (not supported in Node.js built-in) and `execFile`
  async (PID mismatch with `NotifyAccess=main`). Final solution: `execFileSync` with explicit
  `--pid=` flag and `NotifyAccess=all` in the service file
- `src/health-server.ts` — zero-dependency HTTP server on port 3002, 127.0.0.1 only
- Updated systemd service: `Type=notify`, `NotifyAccess=all`, `WatchdogSec=30s`
- Watchdog ticks every 2s (message loop iteration), 30s timeout gives generous buffer

## Level 3: Smoke Test

- `scripts/smoke-test.ts` — standalone script, doesn't import app modules
- Quick mode: hits health endpoint, checks DB staleness (~1 second)
- Full mode: injects test message into messages table, waits for bot response
- Detects stale cursors, disconnected channels, saturated queue, task failures

## Design Decisions

- **Health data is pure**: `collectHealth()` takes flat deps and returns a struct.
  No DB access, no side effects — trivially testable
- **Provider callback pattern**: Avoids changing `executeHostCommand` signature or
  adding a global singleton. The orchestrator registers a closure that captures
  module-level state by reference
- **execFileSync for watchdog**: Node.js doesn't have built-in Unix DGRAM socket
  support. The `systemd-notify` CLI is available on all systemd systems. Using
  `execFileSync` (sync) rather than `execFile` (async) keeps the tick deterministic
  and avoids accumulating background processes
- **Smoke test is standalone**: Doesn't import app code — opens its own DB connection
  and makes HTTP calls. This ensures the test validates the running service, not
  the code
