/**
 * Anthropic subscription rate-limit usage — pure-function fetcher + formatter.
 *
 * Ported from v1 (`src/host-commands.ts`). Surfaces the same `/api/oauth/usage`
 * payload v1's `/usage` slash command rendered: progress bars + reset times
 * for each rate-limit bucket (five_hour / seven_day / seven_day_opus /
 * seven_day_sonnet / extra_usage).
 *
 * Token source: `~/.claude/.credentials.json` (`.claudeAiOauth.accessToken`).
 * OneCLI's vault is not used because (a) the @onecli-sh/sdk has no
 * getSecret-by-name API and (b) OneCLI's gateway proxy injects x-api-key for
 * api.anthropic.com, not the OAuth Bearer + `anthropic-beta` pair this
 * endpoint requires. See docs/archive/v2-migration/p3-notes.md §11.
 *
 * Refresh: if the token is within 5 minutes of `expiresAt`, POSTs to
 * console.anthropic.com/v1/oauth/token with the refresh token and writes the
 * updated credentials back to disk. `claude setup-token` on the host updates
 * the same file out-of-band, so both Claude Code and this module share state.
 */

import fs from 'fs';
import path from 'path';
import { TIMEZONE } from './config.js';
import { log } from './log.js';

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_opus: 'Current week (Opus only)',
  seven_day_sonnet: 'Current week (Sonnet only)',
  extra_usage: 'Extra usage credits',
};

const DISPLAY_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'extra_usage'];

const CREDENTIALS_PATH = path.join(process.env.HOME || '/root', '.claude', '.credentials.json');

const TOKEN_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface UsageBucket {
  utilization: number | null;
  resets_at: string | null;
}

interface ExtraUsageBucket extends UsageBucket {
  is_enabled?: boolean;
  monthly_limit?: number | null;
  used_credits?: number | null;
  currency?: string | null;
  disabled_reason?: string | null;
}

export interface UsageApiResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  extra_usage?: ExtraUsageBucket | null;
  [key: string]: unknown;
}

interface OAuthCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
}

export type UsageFailure =
  | { reason: 'no_credentials' }
  | { reason: 'token_expired' }
  | { reason: 'api_error'; status: number }
  | { reason: 'network_error'; message: string };

export type UsageResult = { ok: true; data: UsageApiResponse } | { ok: false; failure: UsageFailure };

// --- credentials I/O (visible for tests via the path override) ---

let credentialsPath = CREDENTIALS_PATH;

/** Override the credentials file path. Test-only. */
export function setCredentialsPathForTesting(p: string): void {
  credentialsPath = p;
}

function readCredentials(): OAuthCredentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath, 'utf-8');
    return JSON.parse(raw) as OAuthCredentials;
  } catch {
    return null;
  }
}

function writeCredentials(creds: OAuthCredentials): void {
  try {
    fs.writeFileSync(credentialsPath, JSON.stringify(creds), 'utf-8');
  } catch (err) {
    log.warn('Failed to write refreshed credentials', { err });
  }
}

async function refreshOAuthToken(creds: OAuthCredentials): Promise<OAuthCredentials | null> {
  const { refreshToken } = creds.claudeAiOauth;
  if (!refreshToken) return null;

  try {
    const resp = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });

    if (!resp.ok) {
      log.warn('OAuth token refresh failed', { status: resp.status });
      return null;
    }

    const data = (await resp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const updated: OAuthCredentials = {
      ...creds,
      claudeAiOauth: {
        ...creds.claudeAiOauth,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: Date.now() + (data.expires_in ?? 28800) * 1000,
      },
    };

    writeCredentials(updated);
    log.info('OAuth token refreshed successfully');
    return updated;
  } catch (err) {
    log.warn('OAuth token refresh error', { err });
    return null;
  }
}

/** Returns a valid access token, refreshing if expired. Null if no credentials. */
export async function getValidAccessToken(): Promise<string | null> {
  let creds = readCredentials();
  if (!creds?.claudeAiOauth?.accessToken) return null;

  const { expiresAt } = creds.claudeAiOauth;
  if (expiresAt && Date.now() >= expiresAt - REFRESH_BUFFER_MS) {
    log.debug('OAuth token expired or expiring soon, refreshing');
    const refreshed = await refreshOAuthToken(creds);
    if (refreshed) {
      creds = refreshed;
    } else {
      // Refresh failed — re-read credentials.json in case another process
      // (e.g. Claude Code on the host) refreshed since we last read it.
      const reread = readCredentials();
      if (reread?.claudeAiOauth?.accessToken && reread.claudeAiOauth.accessToken !== creds.claudeAiOauth.accessToken) {
        log.debug('Picked up externally refreshed token');
        creds = reread;
      } else if (reread?.claudeAiOauth?.refreshToken) {
        // Same access token but try refresh once more after a brief pause
        // (covers transient network errors and rate-limit backoff)
        await new Promise((r) => setTimeout(r, 2000));
        const retried = await refreshOAuthToken(reread);
        if (retried) {
          creds = retried;
        } else if (Date.now() >= expiresAt) {
          return null;
        }
      } else if (Date.now() >= expiresAt) {
        return null;
      }
    }
  }

  return creds.claudeAiOauth.accessToken;
}

/** Fetch current usage from the Anthropic OAuth usage endpoint. */
export async function fetchUsage(): Promise<UsageResult> {
  let token: string | null;
  try {
    token = await getValidAccessToken();
  } catch (err) {
    return {
      ok: false,
      failure: { reason: 'network_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!token) {
    const creds = readCredentials();
    if (!creds?.claudeAiOauth?.accessToken) {
      return { ok: false, failure: { reason: 'no_credentials' } };
    }
    return { ok: false, failure: { reason: 'token_expired' } };
  }

  try {
    const resp = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!resp.ok) {
      return { ok: false, failure: { reason: 'api_error', status: resp.status } };
    }
    return { ok: true, data: (await resp.json()) as UsageApiResponse };
  } catch (err) {
    return {
      ok: false,
      failure: { reason: 'network_error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// --- formatters ---

export function renderProgressBar(utilization: number, width: number = 50): string {
  const filled = Math.round(utilization * width);
  const empty = width - filled;
  const bar = '▓'.repeat(filled) + '░'.repeat(empty);
  const pct = Math.round(utilization * 100);
  return `${bar} ${pct}% used`;
}

function formatResetTime(resetTime: string | number, timezone: string): string {
  let date: Date;
  if (typeof resetTime === 'string') {
    date = new Date(resetTime);
  } else {
    // Tolerate epoch-seconds vs epoch-ms in case upstream changes.
    const epochMs = resetTime < 1e12 ? resetTime * 1000 : resetTime;
    date = new Date(epochMs);
  }
  const now = new Date();

  const todayStr = now.toLocaleDateString('en-CA', { timeZone: timezone });
  const resetStr = date.toLocaleDateString('en-CA', { timeZone: timezone });

  const timeStr = date
    .toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .toLowerCase()
    .replace(':00', '')
    .replace(' ', '');

  if (todayStr === resetStr) {
    return `Resets ${timeStr} (${timezone})`;
  }
  const dateFormatted = date.toLocaleDateString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
  });
  return `Resets ${dateFormatted}, ${timeStr} (${timezone})`;
}

/** Render the usage response into a Slack/markdown-friendly multi-line string. */
export function formatUsage(data: UsageApiResponse, timezone: string = TIMEZONE): string {
  const sections: string[] = [];

  for (const key of DISPLAY_ORDER) {
    const bucket = data[key] as UsageBucket | null | undefined;
    if (!bucket || bucket.utilization == null) continue;

    const label = RATE_LIMIT_LABELS[key] || key;
    const lines: string[] = [`*${label}*`];
    lines.push(renderProgressBar(bucket.utilization / 100));
    if (bucket.resets_at) {
      lines.push(formatResetTime(bucket.resets_at, timezone));
    }
    sections.push(lines.join('\n'));
  }

  // Surface extra_usage state when no utilization line came through above
  // (organisation-disabled state still useful to see).
  const extra = data.extra_usage as ExtraUsageBucket | null | undefined;
  if (extra && extra.utilization == null && extra.is_enabled === false) {
    sections.push(['*Extra usage credits*', `Disabled (${extra.disabled_reason || 'no reason given'})`].join('\n'));
  }

  return sections.length > 0 ? sections.join('\n\n') : 'No usage data available.';
}

export function formatUsageFailure(failure: UsageFailure): string {
  switch (failure.reason) {
    case 'no_credentials':
      return [
        '*Usage unavailable — no OAuth credentials found.*',
        '',
        'Run `claude setup-token` on the server to authenticate, then try again.',
      ].join('\n');
    case 'token_expired':
      return [
        '*Usage unavailable — OAuth token expired and refresh failed.*',
        '',
        'Run `claude setup-token` on the server to re-authenticate, then try again.',
      ].join('\n');
    case 'api_error':
      return [
        `*Usage unavailable — API returned ${failure.status}.*`,
        '',
        failure.status === 429
          ? 'Rate limited. Wait a minute and try again.'
          : 'Run `claude setup-token` on the server to re-authenticate, then try again.',
      ].join('\n');
    case 'network_error':
      return ['*Usage unavailable — network error.*', '', failure.message].join('\n');
  }
}

/** Convenience: fetch + render in one call, returning a single string. */
export async function getUsageText(timezone: string = TIMEZONE): Promise<string> {
  const result = await fetchUsage();
  if (result.ok) return formatUsage(result.data, timezone);
  return formatUsageFailure(result.failure);
}
