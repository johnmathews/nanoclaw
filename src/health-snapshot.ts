/**
 * Composes a fresh HealthData snapshot from runtime state.
 *
 * Extracted from `src/index.ts` so host-side commands can call it without
 * pulling the entry-point module into their import graph. The pure assembly
 * lives in `health.ts` (`collectHealth`); this module supplies the I/O
 * (channel registry, delivery loops, DB, per-session inbound DBs).
 */
import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { getDb } from './db/connection.js';
import { getDeliveryPollsRunning } from './delivery.js';
import { isHostSweepRunning } from './host-sweep.js';
import { collectHealth, type HealthData } from './health.js';
import { getActiveContainerCount } from './container-runner.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getActiveSessions } from './db/sessions.js';
import { openInboundDb } from './session-manager.js';
import { getActiveAdapters } from './channels/channel-registry.js';
import { log } from './log.js';

export function snapshotHealth(): HealthData {
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
