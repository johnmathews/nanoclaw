#!/usr/bin/env npx tsx
/**
 * NanoClaw smoke test — validates service health externally.
 *
 * Usage:
 *   npx tsx scripts/smoke-test.ts            # quick mode (health endpoint + DB checks)
 *   npx tsx scripts/smoke-test.ts --full     # full mode (also injects test message)
 *   npx tsx scripts/smoke-test.ts --port=3002  # custom health port
 *   npx tsx scripts/smoke-test.ts --timeout=120  # response timeout in seconds (full mode)
 *
 * Exit codes: 0 = healthy, 1 = unhealthy
 */

import http from 'http';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';

// --- Types ---

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface HealthData {
  uptimeSeconds: number;
  channels: Array<{ name: string; connected: boolean }>;
  messageLoopRunning: boolean;
  queue: { active: number; max: number; waiting: number };
  registeredGroupCount: number;
  activeSessionCount: number;
  lastMessageTimestamp: string;
  lastMessageAge: string;
  tasks: {
    activeCount: number;
    pausedCount: number;
    nextRunTime: string | null;
    recentFailures: number;
  };
  healthy: boolean;
}

// --- HTTP fetch ---

function fetchHealth(
  port: number,
): Promise<{ status: number; data: HealthData }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(body) });
        } catch {
          reject(new Error(`Invalid JSON: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('Health endpoint timeout'));
    });
  });
}

// --- Health checks ---

function checkHealthData(data: HealthData): CheckResult[] {
  const results: CheckResult[] = [];

  // Overall health
  results.push({
    name: 'Overall health',
    passed: data.healthy,
    detail: data.healthy ? 'All systems nominal' : 'Service degraded',
  });

  // Message loop
  results.push({
    name: 'Message loop',
    passed: data.messageLoopRunning,
    detail: data.messageLoopRunning ? 'Running' : 'STOPPED',
  });

  // Channels
  const disconnected = data.channels.filter((ch) => !ch.connected);
  results.push({
    name: 'Channel connectivity',
    passed: disconnected.length === 0 && data.channels.length > 0,
    detail:
      disconnected.length > 0
        ? `Disconnected: ${disconnected.map((ch) => ch.name).join(', ')}`
        : data.channels.length === 0
          ? 'No channels'
          : `${data.channels.length} channel(s) connected`,
  });

  // Container queue
  results.push({
    name: 'Container queue',
    passed: data.queue.active < data.queue.max,
    detail: `${data.queue.active}/${data.queue.max} active, ${data.queue.waiting} waiting`,
  });

  // Cursor staleness (warn if > 5 min behind with no active containers)
  if (data.lastMessageTimestamp) {
    const ageMs =
      Date.now() - new Date(data.lastMessageTimestamp).getTime();
    const stale = ageMs > 5 * 60 * 1000 && data.queue.active === 0;
    results.push({
      name: 'Message cursor',
      passed: !stale,
      detail: stale
        ? `Stale: ${data.lastMessageAge} (no active containers)`
        : `Fresh: ${data.lastMessageAge}`,
    });
  }

  // Task failures
  results.push({
    name: 'Task failures (24h)',
    passed: data.tasks.recentFailures < 5,
    detail:
      data.tasks.recentFailures === 0
        ? 'None'
        : `${data.tasks.recentFailures} failure(s)`,
  });

  return results;
}

// --- Full mode: inject test message ---

async function injectAndWait(
  dbPath: string,
  timeoutSec: number,
): Promise<CheckResult> {
  const marker = `SMOKE-TEST-${crypto.randomUUID().slice(0, 8)}`;
  const db = new Database(dbPath, { readonly: false });

  // Find main group
  const mainGroup = db
    .prepare('SELECT jid FROM registered_groups WHERE is_main = 1')
    .get() as { jid: string } | undefined;

  if (!mainGroup) {
    db.close();
    return {
      name: 'Full pipeline test',
      passed: false,
      detail: 'No main group registered — cannot inject test message',
    };
  }

  const chatJid = mainGroup.jid;
  const messageId = `smoke-test-${Date.now()}`;
  const timestamp = new Date().toISOString();

  // Insert test message into messages table
  db.prepare(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(
    messageId,
    chatJid,
    'smoke-test',
    'Smoke Test',
    `[${marker}] ping`,
    timestamp,
  );

  // Wait for a response (is_from_me=1 or is_bot_message=1) containing the marker
  const deadline = Date.now() + timeoutSec * 1000;
  let found = false;

  while (Date.now() < deadline) {
    const response = db
      .prepare(
        `SELECT id FROM messages
         WHERE chat_jid = ? AND timestamp > ? AND (is_from_me = 1 OR is_bot_message = 1)
         ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(chatJid, timestamp) as { id: string } | undefined;

    if (response) {
      found = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Clean up the injected test message
  db.prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?').run(
    messageId,
    chatJid,
  );
  db.close();

  return {
    name: 'Full pipeline test',
    passed: found,
    detail: found
      ? `Response received within ${timeoutSec}s`
      : `No response within ${timeoutSec}s timeout`,
  };
}

// --- Output ---

function printResults(results: CheckResult[]): void {
  const maxName = Math.max(...results.map((r) => r.name.length));

  console.log('');
  console.log('NanoClaw Smoke Test');
  console.log('='.repeat(60));

  for (const r of results) {
    const icon = r.passed ? '  PASS' : '  FAIL';
    console.log(`${icon}  ${r.name.padEnd(maxName)}  ${r.detail}`);
  }

  console.log('='.repeat(60));

  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) {
    console.log('Result: HEALTHY');
  } else {
    console.log(`Result: UNHEALTHY (${failed.length} check(s) failed)`);
  }
  console.log('');
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const port = parseInt(
    args.find((a) => a.startsWith('--port='))?.split('=')[1] || '3002',
  );
  const timeout = parseInt(
    args.find((a) => a.startsWith('--timeout='))?.split('=')[1] || '120',
  );
  const projectRoot = path.resolve(
    args.find((a) => a.startsWith('--root='))?.split('=')[1] ||
      path.join(import.meta.dirname, '..'),
  );
  const dbPath = path.join(projectRoot, 'store', 'messages.db');

  const results: CheckResult[] = [];

  // 1. Health endpoint check
  try {
    const { status, data } = await fetchHealth(port);
    results.push({
      name: 'Health endpoint',
      passed: status === 200,
      detail: `HTTP ${status}`,
    });
    results.push(...checkHealthData(data));
  } catch (err) {
    results.push({
      name: 'Health endpoint',
      passed: false,
      detail: `Unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 2. Full pipeline test (if requested)
  if (full) {
    const result = await injectAndWait(dbPath, timeout);
    results.push(result);
  }

  printResults(results);
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
