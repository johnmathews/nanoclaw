import { TIMEZONE } from './config.js';
import type { RateLimitRow } from './db.js';

export interface HostCommandDeps {
  getRateLimits: () => RateLimitRow[];
}

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_opus: 'Current week (Opus only)',
  seven_day_sonnet: 'Current week (Sonnet only)',
};

const STATUS_LABELS: Record<string, string> = {
  allowed: 'OK',
  allowed_warning: 'Approaching limit',
  rejected: 'Rate limited',
};

function formatResetTime(epoch: number, timezone: string): string {
  // SDK sends resetsAt in seconds; detect and convert to ms
  const epochMs = epoch < 1e12 ? epoch * 1000 : epoch;
  const date = new Date(epochMs);
  const now = new Date();

  const todayStr = now.toLocaleDateString('en-CA', { timeZone: timezone });
  const resetStr = date.toLocaleDateString('en-CA', { timeZone: timezone });

  const timeStr = date.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).toLowerCase().replace(':00', '').replace(' ', '');

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

export function renderProgressBar(utilization: number, width: number = 50): string {
  const filled = Math.round(utilization * width);
  const empty = width - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  const pct = Math.round(utilization * 100);
  return `${bar} ${pct}% used`;
}

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

export async function executeHostCommand(
  command: string,
  deps: HostCommandDeps,
): Promise<string> {
  if (command === '/usage') {
    return executeUsageCommand(deps);
  }
  return `Unknown host command: ${command}`;
}

export function executeUsageCommand(deps: HostCommandDeps): string {
  const rows = deps.getRateLimits();

  if (rows.length === 0) {
    return 'No usage data yet. Send a message first — rate limits appear after the first invocation.';
  }

  // Order: five_hour first, then seven_day variants
  const order = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
  const sorted = [...rows].sort((a, b) => {
    const ai = order.indexOf(a.rate_limit_type);
    const bi = order.indexOf(b.rate_limit_type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return sorted.map(formatRateLimitSection).join('\n\n');
}
