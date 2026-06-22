/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import {
  initTestDb,
  closeDb,
  getDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getDeliveredIds, getDeferredDeliveries } from './db/session-db.js';
import { ChannelDisconnectedError, PermanentDeliveryError } from './channels/delivery-errors.js';
import { resolveSession, outboundDbPath, openInboundDb } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});

describe('deliverSessionMessages — retry and permanent failure', () => {
  it('retries on adapter failure and marks failed after MAX_DELIVERY_ATTEMPTS (3)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('network timeout');
      },
    });

    // Attempt 1
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — should mark as permanently failed
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Attempt 4 — message is now in delivered (as failed), adapter not called
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Verify the message is in the delivered table with 'failed' status
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-flaky')).toBe(true);
  });

  it('clears attempt counter on successful delivery', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retry-ok');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return 'plat-ok';
      },
    });

    // Attempt 1 — fails
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2 — succeeds
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — not called, message already delivered
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);
  });
});

describe('deliverSessionMessages — channel offline (deferral)', () => {
  it('defers (not delivered, not failed) and re-drives when the channel reconnects', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-offline');

    let online = false;
    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        if (!online) throw new ChannelDisconnectedError('socket down');
        return 'plat-ok';
      },
    });

    // First attempt — channel offline → deferred, NOT marked delivered/failed.
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    let inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-offline')).toBe(false); // not terminal
    const deferred = getDeferredDeliveries(inDb);
    expect(deferred.has('out-offline')).toBe(true);
    expect(deferred.get('out-offline')!.attempts).toBe(1);
    inDb.close();

    // Immediate re-poll: backoff gate skips it (adapter not called again).
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Clear the backoff (simulate time passing) and bring the channel online.
    inDb = openInboundDb('ag-1', session.id);
    inDb.prepare('UPDATE delivered SET next_attempt_at = NULL WHERE message_out_id = ?').run('out-offline');
    inDb.close();
    online = true;

    // Now it re-drives and delivers — and the deferred row flips to delivered.
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-offline')).toBe(true);
    expect(getDeferredDeliveries(inDb).has('out-offline')).toBe(false);
    inDb.close();
  });

  it('never burns the retry budget while offline (no permanent fail)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-down');

    setDeliveryAdapter({
      async deliver() {
        throw new ChannelDisconnectedError('still down');
      },
    });

    // Re-drive many times (clearing backoff each round) — must never become
    // a terminal failure; a long outage should not drop the message.
    for (let i = 0; i < 5; i++) {
      const db = openInboundDb('ag-1', session.id);
      db.prepare('UPDATE delivered SET next_attempt_at = NULL WHERE message_out_id = ?').run('out-down');
      db.close();
      await deliverSessionMessages(session);
    }

    const inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-down')).toBe(false); // still not terminal
    expect(getDeferredDeliveries(inDb).has('out-down')).toBe(true);
    inDb.close();
  });
});

describe('deliverSessionMessages — surfacing failures to the agent', () => {
  it('writes a non-waking notice to inbound.db on a permanent failure', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-perm');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new PermanentDeliveryError('An API error occurred: missing_scope', 'missing_scope');
      },
    });

    await deliverSessionMessages(session);

    // Permanent → one attempt, terminal failure, no retries.
    expect(callCount).toBe(1);

    const inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-perm')).toBe(true);

    // A system notice rode in as a context-only (trigger=0) row so the agent
    // learns its message never arrived without waking a deliver→notify loop.
    const notice = inDb
      .prepare('SELECT content, trigger FROM messages_in WHERE id = ?')
      .get('delivery-fail-out-perm') as { content: string; trigger: number } | undefined;
    inDb.close();
    expect(notice).toBeDefined();
    expect(notice!.trigger).toBe(0);
    expect(notice!.content).toContain('could NOT be delivered');
    expect(notice!.content).toContain('missing_scope');
  });

  it('surfaces a notice after transient retries are exhausted', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-exhaust');

    setDeliveryAdapter({
      async deliver() {
        throw new Error('network timeout');
      },
    });

    await deliverSessionMessages(session); // 1
    await deliverSessionMessages(session); // 2
    await deliverSessionMessages(session); // 3 → exhausted

    const inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-exhaust')).toBe(true);
    const notice = inDb.prepare('SELECT id FROM messages_in WHERE id = ?').get('delivery-fail-out-exhaust');
    inDb.close();
    expect(notice).toBeDefined();
  });
});

describe('deliverSessionMessages — reply_mode', () => {
  it("preserves thread_id when reply_mode is explicitly 'thread'", async () => {
    seedAgentAndChannel();
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    // Default is 'channel' (migration 018); threaded replies are opt-in.
    getDb().prepare("UPDATE messaging_groups SET reply_mode = 'thread' WHERE id = ?").run('mg-1');
    const { session } = resolveSession('ag-1', 'mg-1', 'telegram:123:thread-abc', 'shared');

    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?, ?)`,
    ).run('out-thread', 'telegram:123:thread-abc', JSON.stringify({ text: 'hi' }));
    db.close();

    let seenThreadId: string | null | undefined;
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        seenThreadId = threadId;
        return 'plat-msg';
      },
    });

    await deliverSessionMessages(session);
    expect(seenThreadId).toBe('telegram:123:thread-abc');
  });

  it("clears thread_id when reply_mode is the default 'channel'", async () => {
    seedAgentAndChannel();
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    const { session } = resolveSession('ag-1', 'mg-1', 'telegram:123:thread-abc', 'shared');

    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?, ?)`,
    ).run('out-chan', 'telegram:123:thread-abc', JSON.stringify({ text: 'hi' }));
    db.close();

    let seenThreadId: string | null | undefined;
    setDeliveryAdapter({
      async deliver(_ct, _pid, threadId) {
        seenThreadId = threadId;
        return 'plat-msg';
      },
    });

    await deliverSessionMessages(session);
    expect(seenThreadId).toBeNull();
  });
});

describe('deliverSessionMessages — permission check', () => {
  it('rejects delivery to an unauthorized channel destination', async () => {
    seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert an outbound message targeting mg-2 (discord) — not the origin chat
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:456', 'discord', ?)`,
      )
      .run('out-unauth', JSON.stringify({ text: 'sneaky' }));
    outDb.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    // Deliver 3 times to exhaust retries
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // Adapter never called — permission check throws before reaching it
    expect(calls).toHaveLength(0);

    // Message is marked as permanently failed
    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-unauth')).toBe(true);
  });
});
