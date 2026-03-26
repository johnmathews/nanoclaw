import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { startHealthServer } from './health-server.js';
import type { HealthData } from './health.js';

const healthyData: HealthData = {
  uptimeSeconds: 3600,
  channels: [{ name: 'WhatsApp', connected: true }],
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

const unhealthyData: HealthData = {
  ...healthyData,
  channels: [{ name: 'WhatsApp', connected: false }],
  healthy: false,
};

function fetch(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      })
      .on('error', reject);
  });
}

describe('health-server', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns 200 with JSON when healthy', async () => {
    server = startHealthServer(0, () => healthyData);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.healthy).toBe(true);
    expect(data.uptimeSeconds).toBe(3600);
    expect(data.channels).toHaveLength(1);
  });

  it('returns 503 when unhealthy', async () => {
    server = startHealthServer(0, () => unhealthyData);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const data = JSON.parse(res.body);
    expect(data.healthy).toBe(false);
  });

  it('returns 404 for other paths', async () => {
    server = startHealthServer(0, () => healthyData);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(404);
  });

  it('returns 500 when health provider throws', async () => {
    server = startHealthServer(0, () => {
      throw new Error('broken');
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(500);
    const data = JSON.parse(res.body);
    expect(data.error).toBe('broken');
  });
});
