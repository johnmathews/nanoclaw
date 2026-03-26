/**
 * Tests for smoke-test utility functions.
 * We extract and test the pure functions — checkHealthData doesn't need mocks.
 */
import { describe, it, expect } from 'vitest';

// Re-implement checkHealthData locally to avoid importing the script
// (which has top-level await and side effects)

interface HealthData {
  uptimeSeconds: number;
  channels: Array<{ name: string; connected: boolean }>;
  messageLoopRunning: boolean;
  queue: { active: number; max: number; waiting: number };
  registeredGroupCount: number;
  activeSessionCount: number;
  lastMessageTimestamp: string;
  lastMessageAge: string;
  tasks: {
    activeCount: number;
    pausedCount: number;
    nextRunTime: string | null;
    recentFailures: number;
  };
  healthy: boolean;
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

function checkHealthData(data: HealthData): CheckResult[] {
  const results: CheckResult[] = [];

  results.push({
    name: 'Overall health',
    passed: data.healthy,
    detail: data.healthy ? 'All systems nominal' : 'Service degraded',
  });

  results.push({
    name: 'Message loop',
    passed: data.messageLoopRunning,
    detail: data.messageLoopRunning ? 'Running' : 'STOPPED',
  });

  const disconnected = data.channels.filter((ch) => !ch.connected);
  results.push({
    name: 'Channel connectivity',
    passed: disconnected.length === 0 && data.channels.length > 0,
    detail:
      disconnected.length > 0
        ? `Disconnected: ${disconnected.map((ch) => ch.name).join(', ')}`
        : data.channels.length === 0
          ? 'No channels'
          : `${data.channels.length} channel(s) connected`,
  });

  results.push({
    name: 'Container queue',
    passed: data.queue.active < data.queue.max,
    detail: `${data.queue.active}/${data.queue.max} active, ${data.queue.waiting} waiting`,
  });

  if (data.lastMessageTimestamp) {
    const ageMs =
      Date.now() - new Date(data.lastMessageTimestamp).getTime();
    const stale = ageMs > 5 * 60 * 1000 && data.queue.active === 0;
    results.push({
      name: 'Message cursor',
      passed: !stale,
      detail: stale
        ? `Stale: ${data.lastMessageAge} (no active containers)`
        : `Fresh: ${data.lastMessageAge}`,
    });
  }

  results.push({
    name: 'Task failures (24h)',
    passed: data.tasks.recentFailures < 5,
    detail:
      data.tasks.recentFailures === 0
        ? 'None'
        : `${data.tasks.recentFailures} failure(s)`,
  });

  return results;
}

function makeHealthy(): HealthData {
  return {
    uptimeSeconds: 3600,
    channels: [
      { name: 'WhatsApp', connected: true },
      { name: 'Slack', connected: true },
    ],
    messageLoopRunning: true,
    queue: { active: 1, max: 5, waiting: 0 },
    registeredGroupCount: 4,
    activeSessionCount: 2,
    lastMessageTimestamp: new Date(Date.now() - 60_000).toISOString(),
    lastMessageAge: '1m ago',
    tasks: {
      activeCount: 3,
      pausedCount: 1,
      nextRunTime: null,
      recentFailures: 0,
    },
    healthy: true,
  };
}

describe('checkHealthData', () => {
  it('all checks pass for healthy service', () => {
    const results = checkHealthData(makeHealthy());
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('fails overall health when unhealthy', () => {
    const data = { ...makeHealthy(), healthy: false };
    const results = checkHealthData(data);
    const overall = results.find((r) => r.name === 'Overall health');
    expect(overall?.passed).toBe(false);
    expect(overall?.detail).toBe('Service degraded');
  });

  it('fails message loop when stopped', () => {
    const data = { ...makeHealthy(), messageLoopRunning: false };
    const results = checkHealthData(data);
    const loop = results.find((r) => r.name === 'Message loop');
    expect(loop?.passed).toBe(false);
  });

  it('fails channel connectivity when disconnected', () => {
    const data = {
      ...makeHealthy(),
      channels: [{ name: 'WhatsApp', connected: false }],
    };
    const results = checkHealthData(data);
    const ch = results.find((r) => r.name === 'Channel connectivity');
    expect(ch?.passed).toBe(false);
    expect(ch?.detail).toContain('WhatsApp');
  });

  it('fails channel connectivity when no channels', () => {
    const data = { ...makeHealthy(), channels: [] };
    const results = checkHealthData(data);
    const ch = results.find((r) => r.name === 'Channel connectivity');
    expect(ch?.passed).toBe(false);
    expect(ch?.detail).toBe('No channels');
  });

  it('fails container queue when saturated', () => {
    const data = {
      ...makeHealthy(),
      queue: { active: 5, max: 5, waiting: 2 },
    };
    const results = checkHealthData(data);
    const q = results.find((r) => r.name === 'Container queue');
    expect(q?.passed).toBe(false);
  });

  it('passes cursor check when fresh', () => {
    const results = checkHealthData(makeHealthy());
    const cursor = results.find((r) => r.name === 'Message cursor');
    expect(cursor?.passed).toBe(true);
  });

  it('fails cursor check when stale and no containers active', () => {
    const data = {
      ...makeHealthy(),
      lastMessageTimestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lastMessageAge: '10m ago',
      queue: { active: 0, max: 5, waiting: 0 },
    };
    const results = checkHealthData(data);
    const cursor = results.find((r) => r.name === 'Message cursor');
    expect(cursor?.passed).toBe(false);
  });

  it('passes cursor check when stale but containers are active', () => {
    const data = {
      ...makeHealthy(),
      lastMessageTimestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lastMessageAge: '10m ago',
      queue: { active: 2, max: 5, waiting: 0 },
    };
    const results = checkHealthData(data);
    const cursor = results.find((r) => r.name === 'Message cursor');
    expect(cursor?.passed).toBe(true);
  });

  it('warns on excessive task failures', () => {
    const data = {
      ...makeHealthy(),
      tasks: { ...makeHealthy().tasks, recentFailures: 10 },
    };
    const results = checkHealthData(data);
    const tf = results.find((r) => r.name === 'Task failures (24h)');
    expect(tf?.passed).toBe(false);
    expect(tf?.detail).toContain('10');
  });

  it('passes with few task failures', () => {
    const data = {
      ...makeHealthy(),
      tasks: { ...makeHealthy().tasks, recentFailures: 2 },
    };
    const results = checkHealthData(data);
    const tf = results.find((r) => r.name === 'Task failures (24h)');
    expect(tf?.passed).toBe(true);
  });
});
