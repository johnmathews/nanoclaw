/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import http from 'http';
import path from 'path';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb, getDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import {
  startActiveDeliveryPoll,
  startSweepDeliveryPoll,
  setDeliveryAdapter,
  stopDeliveryPolls,
  getDeliveryPollsRunning,
} from './delivery.js';
import { startHostSweep, stopHostSweep, isHostSweepRunning } from './host-sweep.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { collectHealth, type HealthData } from './health.js';
import { startHealthServer } from './health-server.js';
import { initWatchdog, type Watchdog } from './watchdog.js';
import { getActiveContainerCount } from './container-runner.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getActiveSessions } from './db/sessions.js';
import { openInboundDb } from './session-manager.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

/**
 * Snapshot of system health.
 *
 * Composes data from channel registry + delivery/sweep loop state + container
 * runner + central DB + per-session inbound DBs (for task counters). Called
 * by the `/health` HTTP endpoint on every request — no caching, snapshot is
 * always fresh. Walks active session DBs in serial; trivially fast for
 * single-digit session counts.
 */
function snapshotHealth(): HealthData {
  const adapters = getActiveAdapters();

  // SQLite's MAX(last_active) is stored timezoneless; append 'Z' so formatAge
  // reads it as UTC. Empty string when no sessions exist yet.
  let lastMessageTimestamp = '';
  try {
    const row = getDb().prepare('SELECT MAX(last_active) AS m FROM sessions').get() as { m: string | null };
    if (row.m) {
      const isoish = row.m.includes('T') ? row.m : row.m.replace(' ', 'T');
      const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : isoish + 'Z';
      lastMessageTimestamp = withZ;
    }
  } catch (err) {
    log.warn('Failed to read sessions.last_active for health snapshot', { err });
  }

  // Walk active session inbound DBs once for task counts. Activated/paused/
  // failed live as `messages_in` rows with kind='task'; v2 has no central
  // task table.
  let activeTasks = 0;
  let pausedTasks = 0;
  let recentTaskFailures = 0;
  let nextTaskRunTime: string | null = null;

  for (const session of getActiveSessions()) {
    let inDb;
    try {
      inDb = openInboundDb(session.agent_group_id, session.id);
    } catch {
      continue;
    }
    try {
      const counts = inDb
        .prepare(
          `SELECT
             SUM(CASE WHEN kind = 'task' AND status = 'pending' THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN kind = 'task' AND status = 'paused' THEN 1 ELSE 0 END) AS paused,
             SUM(CASE WHEN kind = 'task' AND status = 'failed'
                       AND timestamp >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS failures
           FROM messages_in`,
        )
        .get() as { active: number | null; paused: number | null; failures: number | null };
      activeTasks += counts.active ?? 0;
      pausedTasks += counts.paused ?? 0;
      recentTaskFailures += counts.failures ?? 0;

      const nextRow = inDb
        .prepare(
          `SELECT MIN(process_after) AS next FROM messages_in
           WHERE kind = 'task' AND status = 'pending' AND process_after IS NOT NULL`,
        )
        .get() as { next: string | null };
      if (nextRow.next) {
        const isoish = nextRow.next.includes('T') ? nextRow.next : nextRow.next.replace(' ', 'T');
        const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : isoish + 'Z';
        if (!nextTaskRunTime || withZ < nextTaskRunTime) {
          nextTaskRunTime = withZ;
        }
      }
    } catch (err) {
      log.warn('Failed to read task counts for health snapshot', { sessionId: session.id, err });
    } finally {
      inDb.close();
    }
  }

  return collectHealth({
    channels: adapters.map((a) => ({ name: a.channelType, isConnected: () => a.isConnected() })),
    messageLoopRunning: getDeliveryPollsRunning() && isHostSweepRunning(),
    queueActiveCount: getActiveContainerCount(),
    queueWaitingCount: 0,
    maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
    registeredGroupCount: getAllAgentGroups().length,
    activeSessionCount: getActiveSessions().length,
    lastMessageTimestamp,
    activeTasks,
    pausedTasks,
    nextTaskRunTime,
    recentTaskFailures,
  });
}

let healthServer: http.Server | null = null;
let watchdog: Watchdog | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
const WATCHDOG_TICK_MS = 2000;
const DEFAULT_HEALTH_PORT = 3002;

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  getChannelAdapter,
  getActiveAdapters,
} from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 1c. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  // 8. Start the /health HTTP endpoint (loopback only).
  const healthPort = parseInt(process.env.HEALTH_PORT || String(DEFAULT_HEALTH_PORT), 10);
  healthServer = startHealthServer(healthPort, snapshotHealth);

  // 9. systemd watchdog — sd_notify READY=1 + 2s WATCHDOG ticks.
  // Returns null when NOTIFY_SOCKET is absent (Type=simple unit, dev mode);
  // code path is a no-op in that case.
  watchdog = initWatchdog();
  if (watchdog) {
    const wd = watchdog;
    watchdogTimer = setInterval(() => wd.tick(), WATCHDOG_TICK_MS);
    watchdogTimer.unref();
  }

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  watchdog?.close();
  if (healthServer) {
    await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    healthServer = null;
  }
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
