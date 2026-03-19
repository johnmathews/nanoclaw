import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  executeUsageCommand,
  executeHostCommand,
  renderProgressBar,
} from './host-commands.js';
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
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    readFileSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'test-token' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('dispatches /usage and uses API data when available', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 28.0,
            resets_at: '2026-03-19T23:00:00.122619+00:00',
          },
          seven_day: {
            utilization: 27.0,
            resets_at: '2026-03-20T13:00:01.122637+00:00',
          },
          seven_day_sonnet: {
            utilization: 8.0,
            resets_at: '2026-03-20T22:00:01.122644+00:00',
          },
          seven_day_opus: null,
        }),
        { status: 200 },
      ),
    );
    const deps: HostCommandDeps = { getRateLimits: () => [] };
    const result = await executeHostCommand('/usage', deps);
    expect(result).toContain('Current session');
    expect(result).toContain('28% used');
    expect(result).toContain('Current week (all models)');
    expect(result).toContain('27% used');
    expect(result).toContain('Current week (Sonnet only)');
    expect(result).toContain('8% used');
    expect(result).not.toContain('Opus');
    expect(result).toContain('Resets');
  });

  it('falls back to DB data when no credentials file', async () => {
    readFileSpy.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ status: 'allowed' })],
    };
    const result = await executeHostCommand('/usage', deps);
    expect(result).toContain('OK');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to DB data when API returns non-ok', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 401 }));
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ status: 'allowed' })],
    };
    const result = await executeHostCommand('/usage', deps);
    expect(result).toContain('OK');
  });

  it('falls back to DB data when API fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));
    const deps: HostCommandDeps = {
      getRateLimits: () => [makeRow({ status: 'allowed' })],
    };
    const result = await executeHostCommand('/usage', deps);
    expect(result).toContain('OK');
  });

  it('returns error for unknown commands', async () => {
    const deps: HostCommandDeps = { getRateLimits: () => [] };
    const result = await executeHostCommand('/unknown', deps);
    expect(result).toContain('Unknown command');
  });

  it('displays API sections in correct order', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          seven_day_sonnet: { utilization: 8.0, resets_at: null },
          five_hour: { utilization: 28.0, resets_at: null },
          seven_day: { utilization: 27.0, resets_at: null },
        }),
        { status: 200 },
      ),
    );
    const deps: HostCommandDeps = { getRateLimits: () => [] };
    const result = await executeHostCommand('/usage', deps);
    const sessionIdx = result.indexOf('Current session');
    const weekIdx = result.indexOf('Current week (all models)');
    const sonnetIdx = result.indexOf('Current week (Sonnet only)');
    expect(sessionIdx).toBeLessThan(weekIdx);
    expect(weekIdx).toBeLessThan(sonnetIdx);
  });

  it('skips null buckets from API', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 28.0, resets_at: null },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
        }),
        { status: 200 },
      ),
    );
    const deps: HostCommandDeps = { getRateLimits: () => [] };
    const result = await executeHostCommand('/usage', deps);
    expect(result).toContain('Current session');
    expect(result).not.toContain('Current week');
  });
});
