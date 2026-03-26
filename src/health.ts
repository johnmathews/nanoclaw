export interface ChannelHealth {
  name: string;
  connected: boolean;
}

export interface QueueHealth {
  active: number;
  max: number;
  waiting: number;
}

export interface TaskHealth {
  activeCount: number;
  pausedCount: number;
  nextRunTime: string | null;
  recentFailures: number;
}

export interface HealthData {
  uptimeSeconds: number;
  channels: ChannelHealth[];
  messageLoopRunning: boolean;
  queue: QueueHealth;
  registeredGroupCount: number;
  activeSessionCount: number;
  lastMessageTimestamp: string;
  lastMessageAge: string;
  tasks: TaskHealth;
  healthy: boolean;
}

export interface HealthDeps {
  channels: Array<{ name: string; isConnected(): boolean }>;
  messageLoopRunning: boolean;
  queueActiveCount: number;
  queueWaitingCount: number;
  maxConcurrentContainers: number;
  registeredGroupCount: number;
  activeSessionCount: number;
  lastMessageTimestamp: string;
  activeTasks: number;
  pausedTasks: number;
  nextTaskRunTime: string | null;
  recentTaskFailures: number;
}

export function formatAge(isoTimestamp: string): string {
  if (!isoTimestamp) return 'never';

  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return 'unknown';

  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'in the future';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function collectHealth(deps: HealthDeps): HealthData {
  const allChannelsConnected =
    deps.channels.length > 0 && deps.channels.every((ch) => ch.isConnected());

  const healthy = allChannelsConnected && deps.messageLoopRunning;

  return {
    uptimeSeconds: Math.floor(process.uptime()),
    channels: deps.channels.map((ch) => ({
      name: ch.name,
      connected: ch.isConnected(),
    })),
    messageLoopRunning: deps.messageLoopRunning,
    queue: {
      active: deps.queueActiveCount,
      max: deps.maxConcurrentContainers,
      waiting: deps.queueWaitingCount,
    },
    registeredGroupCount: deps.registeredGroupCount,
    activeSessionCount: deps.activeSessionCount,
    lastMessageTimestamp: deps.lastMessageTimestamp,
    lastMessageAge: formatAge(deps.lastMessageTimestamp),
    tasks: {
      activeCount: deps.activeTasks,
      pausedCount: deps.pausedTasks,
      nextRunTime: deps.nextTaskRunTime,
      recentFailures: deps.recentTaskFailures,
    },
    healthy,
  };
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatHealthText(data: HealthData): string {
  const lines: string[] = [];

  lines.push('*NanoClaw Status*');
  lines.push('');
  lines.push(`Uptime: ${formatUptime(data.uptimeSeconds)}`);
  lines.push(
    `Message loop: ${data.messageLoopRunning ? 'running' : 'STOPPED'}`,
  );
  lines.push('');

  // Channels
  lines.push('*Channels*');
  if (data.channels.length === 0) {
    lines.push('  (none connected)');
  } else {
    for (const ch of data.channels) {
      lines.push(
        `  ${ch.name}: ${ch.connected ? 'connected' : 'DISCONNECTED'}`,
      );
    }
  }
  lines.push('');

  // Containers
  lines.push('*Containers*');
  lines.push(
    `  Active: ${data.queue.active}/${data.queue.max} | Waiting: ${data.queue.waiting}`,
  );
  lines.push('');

  // Groups & Sessions
  lines.push('*Groups & Sessions*');
  lines.push(
    `  Registered: ${data.registeredGroupCount} | Sessions: ${data.activeSessionCount}`,
  );
  lines.push('');

  // Message Cursor
  lines.push('*Message Cursor*');
  if (data.lastMessageTimestamp) {
    lines.push(`  Last: ${data.lastMessageAge} (${data.lastMessageTimestamp})`);
  } else {
    lines.push('  Last: never');
  }
  lines.push('');

  // Scheduled Tasks
  lines.push('*Scheduled Tasks*');
  lines.push(
    `  Active: ${data.tasks.activeCount} | Paused: ${data.tasks.pausedCount}`,
  );
  if (data.tasks.nextRunTime) {
    lines.push(
      `  Next run: ${formatAge(data.tasks.nextRunTime).replace(' ago', '')}`,
    );
  }
  lines.push(`  Failures (24h): ${data.tasks.recentFailures}`);

  return lines.join('\n');
}
