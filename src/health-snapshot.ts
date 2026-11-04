/**
 * Composes a fresh HealthData snapshot from runtime state.
 *
 * The pure assembly lives in `health.ts` (`collectHealth`); this module
 * supplies the I/O. Three things changed when this was carried onto upstream
 * v2026.10.0, and each is a behaviour note rather than a mechanical edit:
 *
 *  - Task counts come from the mailbox's task table (`listLiveTasks`), not
 *    from scanning `messages_in` for `kind='task'`. Upstream moved scheduled
 *    tasks out of the message stream into their own records, so the old query
 *    would now count nothing.
 *  - Recent task failures come from the `task_outcomes` log rather than from
 *    `status='failed'` task rows. `listLiveTasks` only exposes pending and
 *    paused, and the outcome log is the better source anyway: it is written
 *    precisely when the host gives up on a message, and it carries the reason.
 *  - There is no container concurrency cap upstream, so `max` is reported as
 *    0, meaning "uncapped".
 */
import { getAllAgentGroups } from './db/agent-groups.js';
import { getActiveSessions } from './db/sessions.js';
import { getDb } from './db/connection.js';
import { listTaskOutcomes } from './db/task-outcomes.js';
import { getActiveContainerCount } from './container-runner.js';
import { getActiveAdapters } from './channels/channel-registry.js';
import { getDeliveryPollsRunning } from './delivery.js';
import { isHostSweepRunning } from './host-sweep.js';
import { collectHealth, type HealthData } from './health.js';
import { log } from './log.js';
import { withExistingMailboxSession } from './session-manager.js';

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** SQLite timestamps are stored timezoneless; normalize to an ISO UTC string. */
function asUtcIso(raw: string): string {
  const isoish = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : `${isoish}Z`;
}

export async function snapshotHealth(): Promise<HealthData> {
  const adapters = getActiveAdapters();

  let lastMessageTimestamp = '';
  try {
    const row = await getDb().get<{ m: string | null }>('SELECT MAX(last_active) AS m FROM sessions');
    if (row?.m) lastMessageTimestamp = asUtcIso(row.m);
  } catch (err) {
    log.warn('Failed to read sessions.last_active for health snapshot', { err });
  }

  const sessions = await getActiveSessions();
  const groups = await getAllAgentGroups();

  let activeTasks = 0;
  let pausedTasks = 0;
  let recentTaskFailures = 0;
  let nextTaskRunTime: string | null = null;
  const failureCutoff = Date.now() - FAILURE_WINDOW_MS;

  for (const session of sessions) {
    // A session whose mailbox does not exist yet simply contributes nothing.
    try {
      await withExistingMailboxSession(session.agent_group_id, session.id, async (mailbox) => {
        const pending = mailbox.listLiveTasks('pending');
        activeTasks += pending.length;
        pausedTasks += mailbox.listLiveTasks('paused').length;
        for (const task of pending) {
          if (!task.processAfter) continue;
          const at = asUtcIso(String(task.processAfter));
          if (!nextTaskRunTime || at < nextTaskRunTime) nextTaskRunTime = at;
        }
      });
    } catch (err) {
      log.warn('Failed to read tasks for health snapshot', { sessionId: session.id, err });
    }
  }

  for (const group of groups) {
    try {
      const outcomes = await listTaskOutcomes(group.id);
      recentTaskFailures += outcomes.filter((o) => Date.parse(asUtcIso(o.recorded_at)) >= failureCutoff).length;
    } catch (err) {
      log.warn('Failed to read task outcomes for health snapshot', { agentGroupId: group.id, err });
    }
  }

  return collectHealth({
    channels: adapters.map((a) => ({ name: a.channelType, isConnected: () => a.isConnected() })),
    messageLoopRunning: getDeliveryPollsRunning() && isHostSweepRunning(),
    queueActiveCount: getActiveContainerCount(),
    queueWaitingCount: 0,
    maxConcurrentContainers: 0, // no cap upstream
    registeredGroupCount: groups.length,
    activeSessionCount: sessions.length,
    lastMessageTimestamp,
    activeTasks,
    pausedTasks,
    nextTaskRunTime,
    recentTaskFailures,
  });
}
