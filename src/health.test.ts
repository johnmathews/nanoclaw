import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  collectHealth,
  formatAge,
  formatHealthText,
  type HealthDeps,
} from './health.js';

function makeDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    channels: [
      { name: 'WhatsApp', isConnected: () => true },
      { name: 'Slack', isConnected: () => true },
    ],
    messageLoopRunning: true,
    queueActiveCount: 1,
    queueWaitingCount: 0,
    maxConcurrentContainers: 5,
    registeredGroupCount: 4,
    activeSessionCount: 2,
    lastMessageTimestamp: new Date(Date.now() - 120_000).toISOString(),
    activeTasks: 3,
    pausedTasks: 1,
    nextTaskRunTime: new Date(Date.now() + 600_000).toISOString(),
    recentTaskFailures: 0,
    ...overrides,
  };
}

describe('formatAge', () => {
  it('returns "never" for empty string', () => {
    expect(formatAge('')).toBe('never');
  });

  it('returns "unknown" for invalid date', () => {
    expect(formatAge('not-a-date')).toBe('unknown');
  });

  it('returns seconds for recent timestamps', () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(formatAge(ts)).toBe('30s ago');
  });

  it('returns minutes for timestamps a few minutes old', () => {
    const ts = new Date(Date.now() - 180_000).toISOString();
    expect(formatAge(ts)).toBe('3m ago');
  });

  it('returns hours for timestamps hours old', () => {
    const ts = new Date(Date.now() - 7_200_000).toISOString();
    expect(formatAge(ts)).toBe('2h ago');
  });

  it('returns days for timestamps days old', () => {
    const ts = new Date(Date.now() - 172_800_000).toISOString();
    expect(formatAge(ts)).toBe('2d ago');
  });

  it('returns "in the future" for future timestamps', () => {
    const ts = new Date(Date.now() + 60_000).toISOString();
    expect(formatAge(ts)).toBe('in the future');
  });
});

describe('collectHealth', () => {
  it('reports healthy when all channels connected and loop running', () => {
    const data = collectHealth(makeDeps());
    expect(data.healthy).toBe(true);
    expect(data.messageLoopRunning).toBe(true);
    expect(data.channels).toHaveLength(2);
    expect(data.channels[0]).toEqual({ name: 'WhatsApp', connected: true });
  });

  it('reports unhealthy when a channel is disconnected', () => {
    const data = collectHealth(
      makeDeps({
        channels: [
          { name: 'WhatsApp', isConnected: () => true },
          { name: 'Slack', isConnected: () => false },
        ],
      }),
    );
    expect(data.healthy).toBe(false);
    expect(data.channels[1].connected).toBe(false);
  });

  it('reports unhealthy when message loop is stopped', () => {
    const data = collectHealth(makeDeps({ messageLoopRunning: false }));
    expect(data.healthy).toBe(false);
  });

  it('reports unhealthy when no channels exist', () => {
    const data = collectHealth(makeDeps({ channels: [] }));
    expect(data.healthy).toBe(false);
  });

  it('includes queue state', () => {
    const data = collectHealth(
      makeDeps({ queueActiveCount: 3, queueWaitingCount: 2 }),
    );
    expect(data.queue).toEqual({ active: 3, max: 5, waiting: 2 });
  });

  it('includes task health', () => {
    const data = collectHealth(
      makeDeps({ activeTasks: 5, pausedTasks: 2, recentTaskFailures: 1 }),
    );
    expect(data.tasks.activeCount).toBe(5);
    expect(data.tasks.pausedCount).toBe(2);
    expect(data.tasks.recentFailures).toBe(1);
  });

  it('includes uptime from process.uptime()', () => {
    const data = collectHealth(makeDeps());
    expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('formats last message age', () => {
    const data = collectHealth(
      makeDeps({
        lastMessageTimestamp: new Date(Date.now() - 120_000).toISOString(),
      }),
    );
    expect(data.lastMessageAge).toBe('2m ago');
  });

  it('handles empty last message timestamp', () => {
    const data = collectHealth(makeDeps({ lastMessageTimestamp: '' }));
    expect(data.lastMessageAge).toBe('never');
  });
});

describe('formatHealthText', () => {
  it('produces expected sections', () => {
    const data = collectHealth(makeDeps());
    const text = formatHealthText(data);

    expect(text).toContain('*NanoClaw Status*');
    expect(text).toContain('Message loop: running');
    expect(text).toContain('*Channels*');
    expect(text).toContain('WhatsApp: connected');
    expect(text).toContain('Slack: connected');
    expect(text).toContain('*Containers*');
    expect(text).toContain('Active: 1/5');
    expect(text).toContain('*Groups & Sessions*');
    expect(text).toContain('Registered: 4');
    expect(text).toContain('Sessions: 2');
    expect(text).toContain('*Message Cursor*');
    expect(text).toContain('*Scheduled Tasks*');
    expect(text).toContain('Active: 3 | Paused: 1');
    expect(text).toContain('Failures (24h): 0');
  });

  it('shows STOPPED when message loop is down', () => {
    const data = collectHealth(makeDeps({ messageLoopRunning: false }));
    const text = formatHealthText(data);
    expect(text).toContain('Message loop: STOPPED');
  });

  it('shows DISCONNECTED for offline channels', () => {
    const data = collectHealth(
      makeDeps({
        channels: [{ name: 'Telegram', isConnected: () => false }],
      }),
    );
    const text = formatHealthText(data);
    expect(text).toContain('Telegram: DISCONNECTED');
  });

  it('shows "(none connected)" when no channels', () => {
    const data = collectHealth(makeDeps({ channels: [] }));
    const text = formatHealthText(data);
    expect(text).toContain('(none connected)');
  });

  it('shows "never" when no messages processed', () => {
    const data = collectHealth(makeDeps({ lastMessageTimestamp: '' }));
    const text = formatHealthText(data);
    expect(text).toContain('Last: never');
  });
});
