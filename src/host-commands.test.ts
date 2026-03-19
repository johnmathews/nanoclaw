import { describe, it, expect } from 'vitest';
import { executeUsageCommand, executeHostCommand, renderProgressBar } from './host-commands.js';
import type { HostCommandDeps } from './host-commands.js';
import type { RateLimitRow } from './db.js';

function makeRow(overrides: Partial<RateLimitRow> = {}): RateLimitRow {
  return {
    rate_limit_type: 'five_hour',
    status: 'allowed',
    utilization: null,
    resets_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('executeUsageCommand', () => {
  it('returns helpful message with no data', () => {
    const deps: HostCommandDeps = { getRateLimits: () => [] };
    const result = executeUsageCommand(deps);
    expect(result).toContain('No usage data yet');
  });

  it('shows status text when utilization is null', () => {
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ status: 'allowed' })],
    };
    const result = executeUsageCommand(deps);
    expect(result).toContain('Current session');
    expect(result).toContain('OK');
    expect(result).not.toContain('% used');
  });

  it('shows warning status', () => {
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ status: 'allowed_warning' })],
    };
    const result = executeUsageCommand(deps);
    expect(result).toContain('Approaching limit');
  });

  it('shows rejected status', () => {
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ status: 'rejected' })],
    };
    const result = executeUsageCommand(deps);
    expect(result).toContain('Rate limited');
  });

  it('renders progress bar when utilization is available', () => {
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ utilization: 0.18 })],
    };
    const result = executeUsageCommand(deps);
    expect(result).toContain('18% used');
    expect(result).toMatch(/[\u2588\u2591]/);
    expect(result).not.toContain('OK');
  });

  it('renders multiple rate limit types in order', () => {
    const deps: HostCommandDeps = {
      getRateLimits: () => [
        makeRow({ rate_limit_type: 'seven_day_sonnet', utilization: 0.08 }),
        makeRow({ rate_limit_type: 'five_hour', utilization: 0.18 }),
        makeRow({ rate_limit_type: 'seven_day', utilization: 0.26 }),
      ],
    };
    const result = executeUsageCommand(deps);
    const sessionIdx = result.indexOf('Current session');
    const weekIdx = result.indexOf('Current week (all models)');
    const sonnetIdx = result.indexOf('Current week (Sonnet only)');
    expect(sessionIdx).toBeLessThan(weekIdx);
    expect(weekIdx).toBeLessThan(sonnetIdx);
  });

  it('shows reset time with epoch seconds (SDK format)', () => {
    // 1773961200 seconds = 2026-03-19T23:00:00Z
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ resets_at: 1773961200 })],
    };
    const result = executeUsageCommand(deps);
    expect(result).toContain('Resets');
    // Should NOT show 1970 (which would happen if treated as milliseconds)
    expect(result).not.toContain('1970');
    expect(result).not.toContain('Jan');
  });

  it('handles zero utilization', () => {
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ utilization: 0 })],
    };
    const result = executeUsageCommand(deps);
    expect(result).toContain('0% used');
  });

  it('handles full utilization', () => {
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ utilization: 1.0 })],
    };
    const result = executeUsageCommand(deps);
    expect(result).toContain('100% used');
  });
});

describe('renderProgressBar', () => {
  it('renders correct width and percentage', () => {
    const bar = renderProgressBar(0.5, 10);
    expect(bar).toContain('50% used');
    expect(bar).toMatch(/\u2588{5}\u2591{5}/);
  });

  it('renders empty bar at 0', () => {
    const bar = renderProgressBar(0, 10);
    expect(bar).toContain('0% used');
    expect(bar).toMatch(/\u2591{10}/);
  });

  it('renders full bar at 1', () => {
    const bar = renderProgressBar(1, 10);
    expect(bar).toContain('100% used');
    expect(bar).toMatch(/\u2588{10}/);
  });
});

describe('executeHostCommand', () => {
  it('dispatches /usage', async () => {
    const deps: HostCommandDeps = { getRateLimits: () => [] };
    const result = await executeHostCommand('/usage', deps);
    expect(result).toContain('No usage data');
  });

  it('returns error for unknown commands', async () => {
    const deps: HostCommandDeps = { getRateLimits: () => [] };
    const result = await executeHostCommand('/unknown', deps);
    expect(result).toContain('Unknown host command');
  });
});
