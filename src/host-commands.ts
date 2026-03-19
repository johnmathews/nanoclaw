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

function readOAuthToken(): string | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

async function fetchUsageFromApi(): Promise<UsageApiResponse | null> {
  const token = readOAuthToken();
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
