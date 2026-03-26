import fs from 'fs';
import path from 'path';
import { TIMEZONE } from './config.js';
import type { HealthData } from './health.js';
import { formatHealthText } from './health.js';
import { logger } from './logger.js';

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_opus: 'Current week (Opus only)',
  seven_day_sonnet: 'Current week (Sonnet only)',
  extra_usage: 'Extra usage credits',
};

function formatResetTime(resetTime: string | number, timezone: string): string {
  let date: Date;
  if (typeof resetTime === 'string') {
    date = new Date(resetTime);
  } else {
    // SDK sends resetsAt in seconds; detect and convert to ms
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

export function renderProgressBar(
  utilization: number,
  width: number = 50,
): string {
  const filled = Math.round(utilization * width);
  const empty = width - filled;
  const bar = '\u2593'.repeat(filled) + '\u2591'.repeat(empty);
  const pct = Math.round(utilization * 100);
  return `${bar} ${pct}% used`;
}

// --- API-based usage ---

interface UsageBucket {
  utilization: number | null;
  resets_at: string | null;
}

interface UsageApiResponse {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  seven_day_sonnet?: UsageBucket | null;
  extra_usage?:
    | (UsageBucket & {
        is_enabled?: boolean;
        monthly_limit?: number;
        used_credits?: number;
      })
    | null;
  [key: string]: unknown;
}

const CREDENTIALS_PATH = path.join(
  process.env.HOME || '/root',
  '.claude',
  '.credentials.json',
);

const TOKEN_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Refresh 5 minutes before expiry to avoid race conditions
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

function readCredentials(): OAuthCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(raw) as OAuthCredentials;
  } catch {
    return null;
  }
}

function writeCredentials(creds: OAuthCredentials): void {
  try {
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'Failed to write refreshed credentials');
  }
}

async function refreshOAuthToken(
  creds: OAuthCredentials,
): Promise<OAuthCredentials | null> {
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
      logger.warn({ status: resp.status }, 'OAuth token refresh failed');
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
    logger.info('OAuth token refreshed successfully');
    return updated;
  } catch (err) {
    logger.warn({ err }, 'OAuth token refresh error');
    return null;
  }
}

async function getValidAccessToken(): Promise<string | null> {
  let creds = readCredentials();
  if (!creds?.claudeAiOauth?.accessToken) return null;

  const { expiresAt } = creds.claudeAiOauth;
  if (expiresAt && Date.now() >= expiresAt - REFRESH_BUFFER_MS) {
    logger.debug('OAuth token expired or expiring soon, refreshing');
    const refreshed = await refreshOAuthToken(creds);
    if (refreshed) {
      creds = refreshed;
    } else {
      // Refresh failed — re-read credentials.json in case another process
      // (e.g. Claude Code) refreshed the token since we last read it.
      const reread = readCredentials();
      if (
        reread?.claudeAiOauth?.accessToken &&
        reread.claudeAiOauth.accessToken !== creds.claudeAiOauth.accessToken
      ) {
        logger.debug('Picked up externally refreshed token');
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

/** Why the usage API call failed — used to give actionable error messages. */
type UsageFailure =
  | { reason: 'no_credentials' }
  | { reason: 'token_expired' }
  | { reason: 'api_error'; status: number }
  | { reason: 'network_error'; message: string };

async function fetchUsageFromApi(): Promise<
  { ok: true; data: UsageApiResponse } | { ok: false; failure: UsageFailure }
> {
  const token = await getValidAccessToken();
  if (!token) {
    const creds = readCredentials();
    if (!creds?.claudeAiOauth?.accessToken) {
      return { ok: false, failure: { reason: 'no_credentials' } };
    }
    return { ok: false, failure: { reason: 'token_expired' } };
  }

  const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!resp.ok) {
    return { ok: false, failure: { reason: 'api_error', status: resp.status } };
  }
  return { ok: true, data: (await resp.json()) as UsageApiResponse };
}

const DISPLAY_ORDER = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'extra_usage',
];

function formatApiUsage(data: UsageApiResponse): string {
  const sections: string[] = [];

  for (const key of DISPLAY_ORDER) {
    const bucket = data[key] as UsageBucket | null | undefined;
    if (!bucket || bucket.utilization == null) continue;

    const label = RATE_LIMIT_LABELS[key] || key;
    const lines: string[] = [`*${label}*`];

    lines.push(renderProgressBar(bucket.utilization / 100));

    if (bucket.resets_at) {
      lines.push(formatResetTime(bucket.resets_at, TIMEZONE));
    }

    sections.push(lines.join('\n'));
  }

  return sections.length > 0
    ? sections.join('\n\n')
    : 'No usage data available.';
}

function formatUsageFailure(failure: UsageFailure): string {
  switch (failure.reason) {
    case 'no_credentials':
      return [
        '*Usage unavailable — no OAuth credentials found.*',
        '',
        'Run `claude` on the server to authenticate, then try again.',
      ].join('\n');
    case 'token_expired':
      return [
        '*Usage unavailable — OAuth token expired and refresh failed.*',
        '',
        'Run `claude /login` on the server to re-authenticate, then try again.',
      ].join('\n');
    case 'api_error':
      return [
        `*Usage unavailable — API returned ${failure.status}.*`,
        '',
        failure.status === 429
          ? 'Rate limited. Wait a minute and try again.'
          : 'Run `claude /login` on the server to re-authenticate, then try again.',
      ].join('\n');
    case 'network_error':
      return [
        '*Usage unavailable — network error.*',
        '',
        `${failure.message}`,
      ].join('\n');
  }
}

// --- Health provider ---

let healthProvider: (() => HealthData) | null = null;

export function registerHealthProvider(fn: () => HealthData): void {
  healthProvider = fn;
}

// --- Command dispatch ---

export async function executeHostCommand(command: string): Promise<string> {
  if (command === '/status') {
    if (!healthProvider) {
      return '*Status unavailable — health provider not initialized.*';
    }
    try {
      return formatHealthText(healthProvider());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Health check failed');
      return `*Status error:* ${message}`;
    }
  }
  if (command === '/usage') {
    try {
      const result = await fetchUsageFromApi();
      if (result.ok) return formatApiUsage(result.data);
      logger.debug({ failure: result.failure }, 'Usage API failed');
      return formatUsageFailure(result.failure);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug({ err }, 'Usage API fetch threw');
      return formatUsageFailure({ reason: 'network_error', message });
    }
  }
  return `Unknown command: ${command}`;
}
