import fs from 'fs';
import path from 'path';
import { TIMEZONE } from './config.js';
import type { RateLimitRow } from './db.js';
import { logger } from './logger.js';

export interface HostCommandDeps {
  getRateLimits: () => RateLimitRow[];
}

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_opus: 'Current week (Opus only)',
  seven_day_sonnet: 'Current week (Sonnet only)',
  extra_usage: 'Extra usage credits',
};

const STATUS_LABELS: Record<string, string> = {
  allowed: 'OK',
  allowed_warning: 'Approaching limit',
  rejected: 'Rate limited',
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

const TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
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
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    });

    const resp = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
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
      // Token is expired and refresh failed — return null so we fall back
      if (Date.now() >= expiresAt) return null;
    }
  }

  return creds.claudeAiOauth.accessToken;
}

async function fetchUsageFromApi(): Promise<UsageApiResponse | null> {
  const token = await getValidAccessToken();
  if (!token) return null;

  const resp = await fetch('https://console.anthropic.com/api/oauth/usage', {
    headers: { 'x-api-key': token },
  });
  if (!resp.ok) return null;
  return (await resp.json()) as UsageApiResponse;
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

// --- DB-based fallback ---

function formatRateLimitSection(row: RateLimitRow): string {
  const label = RATE_LIMIT_LABELS[row.rate_limit_type] || row.rate_limit_type;
  const lines: string[] = [];

  lines.push(`*${label}*`);

  if (row.utilization != null) {
    lines.push(renderProgressBar(row.utilization));
  } else {
    lines.push(STATUS_LABELS[row.status] || row.status);
  }

  if (row.resets_at) {
    lines.push(formatResetTime(row.resets_at, TIMEZONE));
  }

  return lines.join('\n');
}

export function executeUsageCommand(deps: HostCommandDeps): string {
  const rows = deps.getRateLimits();

  if (rows.length === 0) {
    return 'No usage data yet. Send a message first — rate limits appear after the first invocation.';
  }

  const order = [
    'five_hour',
    'seven_day',
    'seven_day_opus',
    'seven_day_sonnet',
  ];
  const sorted = [...rows].sort((a, b) => {
    const ai = order.indexOf(a.rate_limit_type);
    const bi = order.indexOf(b.rate_limit_type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return sorted.map(formatRateLimitSection).join('\n\n');
}

// --- Command dispatch ---

export async function executeHostCommand(
  command: string,
  deps: HostCommandDeps,
): Promise<string> {
  if (command === '/usage') {
    // Try API first, fall back to DB-stored rate limit events
    try {
      const apiData = await fetchUsageFromApi();
      if (apiData) return formatApiUsage(apiData);
    } catch (err) {
      logger.debug({ err }, 'Usage API fetch failed, falling back to DB');
    }
    return executeUsageCommand(deps);
  }
  return `Unknown command: ${command}`;
}
