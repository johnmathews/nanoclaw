import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  fetchUsage,
  formatUsage,
  formatUsageFailure,
  getUsageText,
  getValidAccessToken,
  renderProgressBar,
  setCredentialsPathForTesting,
  type UsageApiResponse,
} from './usage.js';

const TZ = 'UTC';

let tmpDir: string;
let credsPath: string;
const originalFetch = global.fetch;

function writeCreds(
  opts: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  } = {},
) {
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: opts.accessToken ?? 'sk-ant-oat01-real',
        refreshToken: opts.refreshToken ?? 'refresh-token',
        expiresAt: opts.expiresAt ?? Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    }),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-usage-test-'));
  credsPath = path.join(tmpDir, '.credentials.json');
  setCredentialsPathForTesting(credsPath);
});

afterEach(() => {
  global.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.restoreAllMocks();
});

describe('renderProgressBar', () => {
  it('produces a 50-char bar with both filled and empty glyphs', () => {
    const bar = renderProgressBar(0.5);
    expect(bar).toContain('50% used');
    // 25 of each glyph + space + percentage
    const filled = (bar.match(/▓/g) || []).length;
    const empty = (bar.match(/░/g) || []).length;
    expect(filled).toBe(25);
    expect(empty).toBe(25);
  });

  it('clamps to all-filled at 100%', () => {
    const bar = renderProgressBar(1.0);
    expect(bar.startsWith('▓'.repeat(50))).toBe(true);
    expect(bar).toContain('100% used');
  });

  it('clamps to all-empty at 0%', () => {
    const bar = renderProgressBar(0);
    expect(bar.startsWith('░'.repeat(50))).toBe(true);
    expect(bar).toContain('0% used');
  });
});

describe('formatUsage', () => {
  it('renders every populated bucket in canonical order', () => {
    const data: UsageApiResponse = {
      five_hour: { utilization: 12, resets_at: null },
      seven_day: { utilization: 16, resets_at: null },
      seven_day_sonnet: { utilization: 3, resets_at: null },
      seven_day_opus: null,
    };
    const out = formatUsage(data, TZ);
    expect(out.indexOf('Current session')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('Current week (all models)')).toBeGreaterThan(out.indexOf('Current session'));
    expect(out.indexOf('Current week (Sonnet only)')).toBeGreaterThan(out.indexOf('Current week (all models)'));
    expect(out).not.toContain('Current week (Opus only)');
  });

  it('skips buckets whose utilization is null', () => {
    const data: UsageApiResponse = {
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: 5, resets_at: null },
    };
    const out = formatUsage(data, TZ);
    expect(out).not.toContain('Current session');
    expect(out).toContain('Current week');
  });

  it('surfaces a disabled extra_usage bucket even with null utilization', () => {
    const data: UsageApiResponse = {
      five_hour: { utilization: 1, resets_at: null },
      extra_usage: {
        utilization: null,
        resets_at: null,
        is_enabled: false,
        disabled_reason: 'org_level_disabled_until',
      },
    };
    const out = formatUsage(data, TZ);
    expect(out).toContain('Extra usage credits');
    expect(out).toContain('Disabled (org_level_disabled_until)');
  });

  it('returns a friendly message when no data is present', () => {
    expect(formatUsage({}, TZ)).toBe('No usage data available.');
  });
});

describe('formatUsageFailure', () => {
  it('explains missing credentials', () => {
    expect(formatUsageFailure({ reason: 'no_credentials' })).toContain('no OAuth credentials');
  });
  it('explains expired token', () => {
    expect(formatUsageFailure({ reason: 'token_expired' })).toContain('expired');
  });
  it('hints rate-limit cooldown on HTTP 429', () => {
    expect(formatUsageFailure({ reason: 'api_error', status: 429 })).toContain('Rate limited');
  });
  it('points to setup-token on other HTTP errors', () => {
    expect(formatUsageFailure({ reason: 'api_error', status: 401 })).toContain('setup-token');
  });
  it('echoes the network error message', () => {
    expect(formatUsageFailure({ reason: 'network_error', message: 'ECONNRESET' })).toContain('ECONNRESET');
  });
});

describe('getValidAccessToken', () => {
  it('returns null when the credentials file is missing', async () => {
    expect(await getValidAccessToken()).toBeNull();
  });

  it('returns the stored access token when it is fresh', async () => {
    writeCreds({ accessToken: 'sk-fresh', expiresAt: Date.now() + 60 * 60 * 1000 });
    expect(await getValidAccessToken()).toBe('sk-fresh');
  });

  it('refreshes a near-expiry token and writes back to disk', async () => {
    writeCreds({
      accessToken: 'sk-stale',
      refreshToken: 'refresh-stale',
      expiresAt: Date.now() + 60 * 1000, // 1m: inside 5m refresh buffer
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'sk-new', refresh_token: 'refresh-new', expires_in: 28800 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const tok = await getValidAccessToken();
    expect(tok).toBe('sk-new');
    expect(fetchMock).toHaveBeenCalledOnce();
    const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    expect(written.claudeAiOauth.accessToken).toBe('sk-new');
    expect(written.claudeAiOauth.refreshToken).toBe('refresh-new');
  });

  it('falls back to an externally-refreshed token when the API call fails', async () => {
    writeCreds({
      accessToken: 'sk-stale',
      refreshToken: 'refresh-stale',
      expiresAt: Date.now() + 60 * 1000,
    });
    // Server returns 500: refresh attempt fails.
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // Between attempts, simulate Claude Code refreshing the file.
      if (calls === 1) {
        const fresh = {
          claudeAiOauth: {
            accessToken: 'sk-external',
            refreshToken: 'refresh-external',
            expiresAt: Date.now() + 60 * 60 * 1000,
            scopes: [],
            subscriptionType: 'max',
            rateLimitTier: 'default_claude_max_20x',
          },
        };
        fs.writeFileSync(credsPath, JSON.stringify(fresh));
      }
      return new Response('boom', { status: 500 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await getValidAccessToken()).toBe('sk-external');
  });
});

describe('fetchUsage', () => {
  it('returns no_credentials when the file is missing', async () => {
    const result = await fetchUsage();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('no_credentials');
  });

  it('returns parsed data on a successful call', async () => {
    writeCreds();
    const usagePayload: UsageApiResponse = {
      five_hour: { utilization: 7, resets_at: '2026-05-22T20:19:00Z' },
      seven_day: { utilization: 12, resets_at: '2026-05-26T00:00:00Z' },
      extra_usage: {
        utilization: null,
        resets_at: null,
        is_enabled: false,
        disabled_reason: 'org_level_disabled_until',
      },
    };
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
      return new Response(JSON.stringify(usagePayload), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchUsage();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.five_hour?.utilization).toBe(7);
      expect(result.data.extra_usage?.is_enabled).toBe(false);
    }
  });

  it('sends the OAuth Bearer + oauth-2025-04-20 beta header on the request', async () => {
    writeCreds({ accessToken: 'sk-real' });
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response('{}', { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await fetchUsage();
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-real');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('returns api_error on non-2xx response', async () => {
    writeCreds();
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await fetchUsage();
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.reason === 'api_error') {
      expect(result.failure.status).toBe(401);
    }
  });

  it('returns network_error when fetch throws', async () => {
    writeCreds();
    global.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const result = await fetchUsage();
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.reason === 'network_error') {
      expect(result.failure.message).toBe('boom');
    }
  });
});

describe('getUsageText', () => {
  it('returns the formatted failure message when no credentials exist', async () => {
    const text = await getUsageText(TZ);
    expect(text).toContain('no OAuth credentials');
  });

  it('returns the formatted usage on success', async () => {
    writeCreds();
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: null } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const text = await getUsageText(TZ);
    expect(text).toContain('Current session');
    expect(text).toContain('42% used');
  });
});
