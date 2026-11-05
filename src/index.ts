/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import http from 'http';
import path from 'path';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { CENTRAL_DB_PATH, DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import {
  abortGatewaySessionObservers,
  adoptRunningSessions,
  resumeGatewaySessionAdmission,
  stopGatewaySessionsForUnavailability,
} from './container-runner.js';
import { closeDb, initDb } from './db/connection.js';
import { initSearchIndexDb } from './db/search-index-db.js';
import { runMigrations } from './db/migrations/index.js';
import { getSessionDriver } from './drivers/index.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { startHostModules, stopHostModules } from './host-lifecycle.js';
import { startGatewayApprovalCoordinator, stopGatewayApprovalCoordinator } from './gateway-approval-coordinator.js';
import { startGatewayAvailabilityMonitor } from './gateway-availability.js';
import { getGatewayProvider } from './gateway-providers/index.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';
import { snapshotHealth } from './health-snapshot.js';
import { startHealthServer } from './health-server.js';
import { initWatchdog, type Watchdog } from './watchdog.js';

// Response registry lives in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler at top level — which
// would hit a TDZ error if the array lived here.
import { getResponseHandlers, type ResponsePayload } from './response-registry.js';

const hostAbortController = new AbortController();

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

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — imports registration modules, including the singular
// mailbox composition slot. Imported for side effects.
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
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';

let stopGatewayAvailabilityMonitor: (() => void) | undefined;
let healthServer: http.Server | null = null;
let watchdog: Watchdog | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;

const DEFAULT_HEALTH_PORT = 3002;
const WATCHDOG_TICK_MS = 2000;

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0.5 Upgrade tripwire — refuse to start if this install was updated
  // outside the sanctioned path (raw `git pull` instead of /update-nanoclaw).
  enforceUpgradeTripwire();

  // Select once and fail before serving if the configured package is absent.
  const gatewayProvider = getGatewayProvider();

  // 1. Init central DB
  const db = await initDb(CENTRAL_DB_PATH, { role: 'host' });
  await runMigrations(db, undefined, { mode: 'auto' });

  // Fork feature: FTS5 index backing search_history. Separate DB file from the
  // central one to avoid lock contention. Failure is non-fatal — search_history
  // degrades to "unavailable" but the host runs.
  try {
    initSearchIndexDb(path.join(DATA_DIR, 'v2-index.db'));
  } catch (err) {
    log.error('Failed to init search index DB — search_history disabled', { err });
  }
  log.info('Central DB ready', { dialect: db.dialect });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  if (db.dialect === 'sqlite') await backfillContainerConfigs();
  else log.info('Skipping local container.json backfill for non-local central DB');

  // Prepare the runtime; inbound routing waits until approval health and adoption are ready.
  await getSessionDriver().ensureReady?.();
  await startHostInstanceLease();
  let releaseInbound!: () => void;
  const inboundReady = new Promise<void>((resolve) => {
    releaseInbound = resolve;
  });

  // 2. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        inboundReady
          .then(() =>
            routeInbound({
              channelType: adapter.channelType,
              // The one host-side stamping seam: adapters stay instance-blind,
              // the host stamps the receiving instance on every inbound event.
              instance: adapter.instance ?? adapter.channelType,
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
            }),
          )
          .catch((err) => {
            log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
          });
      },
      onInboundEvent(event) {
        inboundReady
          .then(() => routeInbound(event))
          .catch((err) => {
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
      onAction(questionId, selectedOption, userId, address) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          instance: address?.instance ?? adapter.instance ?? adapter.channelType,
          messageId: address?.messageId,
          platformId: address?.platformId ?? '',
          threadId: address?.threadId ?? null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 3. Delivery adapter bridge — dispatches to channel adapters by EXACT
  // registry key (instance ?? channelType): a named instance with an
  // offline adapter is never rerouted through a sibling bot. See
  // createChannelDeliveryAdapter in channels/channel-registry.ts.
  const deliveryAdapter = createChannelDeliveryAdapter();
  setDeliveryAdapter(deliveryAdapter);

  // 4. Core starts the selected gateway's normalized approval subscription
  // only after persistence and delivery are ready.
  await startGatewayApprovalCoordinator(gatewayProvider, deliveryAdapter, stopGatewaySessionsForUnavailability, {
    onAvailable: resumeGatewaySessionAdmission,
    waitUntilReady: true,
  });
  stopGatewayAvailabilityMonitor = await startGatewayAvailabilityMonitor(
    gatewayProvider,
    stopGatewaySessionsForUnavailability,
    resumeGatewaySessionAdmission,
  );
  await adoptRunningSessions();
  releaseInbound();

  // 6. Start registered host modules. Imports only registered callbacks; the
  // actual work begins here, after DB + delivery are ready and before polls.
  await startHostModules({ db, deliveryAdapter, signal: hostAbortController.signal });

  // 6. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 8. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 9. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  // 10. Start the /health HTTP endpoint (loopback only).
  const healthPort = parseInt(process.env.HEALTH_PORT || String(DEFAULT_HEALTH_PORT), 10);
  healthServer = startHealthServer(healthPort, snapshotHealth);

  // 11. systemd watchdog — sd_notify READY=1 + 2s WATCHDOG ticks. The live
  // unit is Type=notify with WatchdogSec=30s, so without this systemd times
  // the start out. Returns null when NOTIFY_SOCKET is absent (upstream's
  // Type=simple unit, dev mode) — a no-op there.
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
  hostAbortController.abort();
  stopGatewayAvailabilityMonitor?.();
  await stopGatewayApprovalCoordinator();
  await abortGatewaySessionObservers();
  await stopHostModules();
  // Stamp the durable stop before the DB closes below.
  await stopHostInstanceLease();
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    await closeDb();
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
