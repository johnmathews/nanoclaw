/**
 * snapshotHealth composition.
 *
 * The interesting cases are the three things that changed when this was
 * carried onto upstream: task counts now come from the mailbox task table,
 * recent failures from the task_outcomes log inside a 24h window, and there is
 * no concurrency cap so `max` is 0. Everything is mocked — this is about which
 * source each number comes from, not about the sources themselves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapters = vi.fn(() => [{ channelType: 'slack', isConnected: () => true }]);
const activeSessions = vi.fn();
const allGroups = vi.fn();
const outcomes = vi.fn();
const liveTasks = vi.fn();
const dbGet = vi.fn();

vi.mock('./channels/channel-registry.js', () => ({ getActiveAdapters: () => adapters() }));
vi.mock('./db/sessions.js', () => ({ getActiveSessions: () => activeSessions() }));
vi.mock('./db/agent-groups.js', () => ({ getAllAgentGroups: () => allGroups() }));
vi.mock('./db/task-outcomes.js', () => ({ listTaskOutcomes: (id: string) => outcomes(id) }));
vi.mock('./db/connection.js', () => ({ getDb: () => ({ get: (...a: unknown[]) => dbGet(...a) }) }));
vi.mock('./container-runner.js', () => ({ getActiveContainerCount: () => 2 }));
vi.mock('./delivery.js', () => ({ getDeliveryPollsRunning: () => true }));
vi.mock('./host-sweep.js', () => ({ isHostSweepRunning: () => true }));
vi.mock('./session-manager.js', () => ({
  withExistingMailboxSession: async (_a: string, _s: string, fn: (m: unknown) => Promise<void>) =>
    fn({ listLiveTasks: (status: 'pending' | 'paused') => liveTasks(status) }),
}));

import { snapshotHealth } from './health-snapshot.js';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  adapters.mockReturnValue([{ channelType: 'slack', isConnected: () => true }]);
  activeSessions.mockResolvedValue([{ id: 'sess-1', agent_group_id: 'ag-1' }]);
  allGroups.mockResolvedValue([{ id: 'ag-1' }]);
  outcomes.mockResolvedValue([]);
  liveTasks.mockReturnValue([]);
  dbGet.mockResolvedValue({ m: null });
});

describe('snapshotHealth', () => {
  it('counts active and paused tasks from the mailbox task table', async () => {
    liveTasks.mockImplementation((status: string) =>
      status === 'pending'
        ? [{ processAfter: '2026-11-05 09:00:00' }, { processAfter: null }]
        : [{ processAfter: null }],
    );
    const health = await snapshotHealth();
    expect(health.tasks.activeCount).toBe(2);
    expect(health.tasks.pausedCount).toBe(1);
  });

  it('takes the earliest pending processAfter as the next run time, normalized to UTC', async () => {
    liveTasks.mockImplementation((status: string) =>
      status === 'pending' ? [{ processAfter: '2026-11-06 10:00:00' }, { processAfter: '2026-11-05 09:00:00' }] : [],
    );
    const health = await snapshotHealth();
    expect(health.tasks.nextRunTime).toBe('2026-11-05T09:00:00Z');
  });

  it('counts only task outcomes inside the 24h window', async () => {
    outcomes.mockResolvedValue([
      { recorded_at: hoursAgo(1) },
      { recorded_at: hoursAgo(23) },
      { recorded_at: hoursAgo(25) }, // outside
    ]);
    const health = await snapshotHealth();
    expect(health.tasks.recentFailures).toBe(2);
  });

  it('reports no concurrency cap', async () => {
    const health = await snapshotHealth();
    expect(health.queue.max).toBe(0);
    expect(health.queue.active).toBe(2);
  });

  it('survives a session whose mailbox read throws', async () => {
    liveTasks.mockImplementation(() => {
      throw new Error('mailbox gone');
    });
    const health = await snapshotHealth();
    expect(health.tasks.activeCount).toBe(0);
  });

  it('survives the last_active read failing', async () => {
    dbGet.mockRejectedValue(new Error('db down'));
    await expect(snapshotHealth()).resolves.toBeDefined();
  });
});
