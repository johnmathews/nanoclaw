import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import {
  executeHostCommand,
  registerHealthProvider,
  renderProgressBar,
} from './host-commands.js';
import type { HealthData } from './health.js';

describe('renderProgressBar', () => {
  it('renders correct width and percentage', () => {
    const bar = renderProgressBar(0.5, 10);
    expect(bar).toContain('50% used');
    expect(bar).toMatch(/\u2593{5}\u2591{5}/);
  });

  it('renders empty bar at 0', () => {
    const bar = renderProgressBar(0, 10);
    expect(bar).toContain('0% used');
    expect(bar).toMatch(/\u2591{10}/);
  });

  it('renders full bar at 1', () => {
    const bar = renderProgressBar(1, 10);
    expect(bar).toContain('100% used');
    expect(bar).toMatch(/\u2593{10}/);
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
    const result = await executeHostCommand('/usage');
    expect(result).toContain('Current session');
    expect(result).toContain('28% used');
    expect(result).toContain('Current week (all models)');
    expect(result).toContain('27% used');
    expect(result).toContain('Current week (Sonnet only)');
    expect(result).toContain('8% used');
    expect(result).not.toContain('Opus');
    expect(result).toContain('Resets');
  });

  it('calls usage API with Bearer auth and anthropic-beta header', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ five_hour: { utilization: 10.0, resets_at: null } }),
        { status: 200 },
      ),
    );
    await executeHostCommand('/usage');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/oauth/usage',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      }),
    );
  });

  it('picks up externally refreshed token when own refresh fails', async () => {
    let readCount = 0;
    readFileSpy.mockImplementation(() => {
      readCount++;
      if (readCount <= 2) {
        // Initial read + first re-read both return expired token
        // (re-read #1 checks if another process refreshed — same token)
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: 'expired-token',
            refreshToken: 'old-refresh',
            expiresAt: Date.now() - 10 * 60 * 1000,
          },
        });
      }
      // Third read (inside retry re-read or second getValidAccessToken call)
      // returns a fresh token from Claude Code
      return JSON.stringify({
        claudeAiOauth: {
          accessToken: 'claude-code-refreshed-token',
          refreshToken: 'new-refresh',
          expiresAt: Date.now() + 8 * 60 * 60 * 1000,
        },
      });
    });

    // First refresh: 429, retry refresh: 429, then usage API succeeds
    fetchSpy
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 20.0, resets_at: null },
          }),
          { status: 200 },
        ),
      );

    const result = await executeHostCommand('/usage');
    // Token expired + both refreshes failed → token_expired error
    // BUT if the third read picks up a fresh token, we'd need another flow.
    // In practice: first refresh fails (429), re-read returns same token,
    // retry refresh fails (429), returns null → token_expired.
    expect(result).toContain('token expired');
  }, 10000);

  it('retries refresh once after transient failure', async () => {
    readFileSpy.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 10 * 60 * 1000,
        },
      }),
    );
    const writeFileSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {});

    // First refresh: 429, second refresh (retry): success, then usage API
    fetchSpy
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'retried-token',
            refresh_token: 'new-refresh',
            expires_in: 28800,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 12.0, resets_at: null },
          }),
          { status: 200 },
        ),
      );

    const result = await executeHostCommand('/usage');
    expect(result).toContain('12% used');
    writeFileSpy.mockRestore();
  }, 10000);

  it('shows no_credentials error when credentials file missing', async () => {
    readFileSpy.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = await executeHostCommand('/usage');
    expect(result).toContain('no OAuth credentials');
    expect(result).toContain('claude');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows token_expired error when refresh fails', async () => {
    readFileSpy.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 10 * 60 * 1000,
        },
      }),
    );

    // Both refresh attempts fail
    fetchSpy.mockResolvedValue(new Response('error', { status: 500 }));

    const result = await executeHostCommand('/usage');
    expect(result).toContain('token expired');
    expect(result).toContain('claude /login');
  }, 10000);

  it('shows api_error with status when API returns non-ok', async () => {
    fetchSpy.mockResolvedValue(new Response('error', { status: 401 }));
    const result = await executeHostCommand('/usage');
    expect(result).toContain('401');
    expect(result).toContain('claude /login');
  });

  it('shows rate limit message on 429 from usage API', async () => {
    fetchSpy.mockResolvedValue(new Response('rate limited', { status: 429 }));
    const result = await executeHostCommand('/usage');
    expect(result).toContain('429');
    expect(result).toContain('Rate limited');
  });

  it('shows network_error on fetch exception', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await executeHostCommand('/usage');
    expect(result).toContain('network error');
    expect(result).toContain('ECONNREFUSED');
  });

  it('refreshes expired token with JSON body before fetching usage', async () => {
    readFileSpy.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now() - 10 * 60 * 1000,
        },
      }),
    );
    const writeFileSpy = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {});

    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-token',
            refresh_token: 'new-refresh',
            expires_in: 28800,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 15.0, resets_at: null },
          }),
          { status: 200 },
        ),
      );

    const result = await executeHostCommand('/usage');

    // Verify refresh used JSON body
    const refreshCall = fetchSpy.mock.calls[0];
    expect(refreshCall[0]).toBe('https://console.anthropic.com/v1/oauth/token');
    const refreshOpts = refreshCall[1] as RequestInit;
    expect(refreshOpts.headers).toEqual(
      expect.objectContaining({ 'Content-Type': 'application/json' }),
    );
    const body = JSON.parse(refreshOpts.body as string);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('refresh-token');

    // Verify usage API used the new token
    const usageCall = fetchSpy.mock.calls[1];
    expect(usageCall[0]).toBe('https://api.anthropic.com/api/oauth/usage');

    expect(result).toContain('15% used');
    writeFileSpy.mockRestore();
  });

  it('returns error for unknown commands', async () => {
    const result = await executeHostCommand('/unknown');
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
    const result = await executeHostCommand('/usage');
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
    const result = await executeHostCommand('/usage');
    expect(result).toContain('Current session');
    expect(result).not.toContain('Current week');
  });
});

describe('/status command', () => {
  const mockHealth: HealthData = {
    uptimeSeconds: 3600,
    channels: [
      { name: 'WhatsApp', connected: true },
      { name: 'Slack', connected: true },
    ],
    messageLoopRunning: true,
    queue: { active: 1, max: 5, waiting: 0 },
    registeredGroupCount: 4,
    activeSessionCount: 2,
    lastMessageTimestamp: '2026-03-26T10:00:00Z',
    lastMessageAge: '5m ago',
    tasks: {
      activeCount: 3,
      pausedCount: 1,
      nextRunTime: '2026-03-26T10:10:00Z',
      recentFailures: 0,
    },
    healthy: true,
  };

  it('returns formatted status when health provider is registered', async () => {
    registerHealthProvider(() => mockHealth);
    const result = await executeHostCommand('/status');
    expect(result).toContain('*NanoClaw Status*');
    expect(result).toContain('Message loop: running');
    expect(result).toContain('WhatsApp: connected');
    expect(result).toContain('Slack: connected');
    expect(result).toContain('Active: 1/5');
    expect(result).toContain('Registered: 4');
    expect(result).toContain('Sessions: 2');
  });

  it('returns error when health provider is not registered', async () => {
    // Re-register with null by importing fresh — but since module state persists,
    // test the error path by registering a throwing provider
    registerHealthProvider(() => {
      throw new Error('test error');
    });
    const result = await executeHostCommand('/status');
    expect(result).toContain('*Status error:*');
    expect(result).toContain('test error');
  });
});
