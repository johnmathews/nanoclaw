/**
 * The task-outcome hook in resetStuckProcessingRows.
 *
 * The point of the feature is that giving up on a message records *why*, with
 * enough context to tell a scheduled-task failure from a chat one and to tie
 * repeated failures of one recurring series together. So the assertions are:
 * it fires only on the terminal give-up (never on a backoff retry), and it
 * carries kind and series_id through — which is why MessageRetry was widened.
 *
 * recordTaskOutcome is mocked: this is about the wiring and the payload, not
 * about the central DB write (covered in db/task-outcomes.test.ts).
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRecord = vi.fn().mockResolvedValue(undefined);
vi.mock('./db/task-outcomes.js', () => ({
  recordTaskOutcome: (...args: unknown[]) => mockRecord(...args),
}));

import { _resetStuckProcessingRowsForTesting } from './reconcile-session.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './mailbox/sqlite/index.js';
import type { Session } from './types.js';

const MAX_TRIES = 5;

function makeSessionDbs() {
  const rawIn = new Database(':memory:');
  rawIn.exec(`CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
    status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, series_id TEXT,
    tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, platform_id TEXT,
    channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
  );`);
  const rawOut = new Database(':memory:');
  rawOut.exec(`CREATE TABLE processing_ack (
    message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT NOT NULL
  );`);
  return {
    inDb: Object.assign(wrapSqliteInbound(rawIn), { prepare: rawIn.prepare.bind(rawIn) }),
    outDb: Object.assign(wrapSqliteOutbound(rawOut), { prepare: rawOut.prepare.bind(rawOut) }),
  };
}

function session(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  } as Session;
}

/** A stale claim on one message with the given tries/kind/series. */
function stuck(dbs: ReturnType<typeof makeSessionDbs>, tries: number, kind: string, seriesId: string | null): void {
  const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  dbs.inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, tries, series_id)
       VALUES ('m-1', 1, ?, ?, 'pending', '{}', ?, ?)`,
    )
    .run(kind, claimedAt, tries, seriesId);
  dbs.outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);
}

beforeEach(() => mockRecord.mockClear());

describe('task-outcome hook', () => {
  it('records an outcome when a message is given up on', async () => {
    const dbs = makeSessionDbs();
    stuck(dbs, MAX_TRIES, 'task', 'daily-digest');
    _resetStuckProcessingRowsForTesting(dbs.inDb, dbs.outDb, session(), 'claim-stuck');
    await vi.waitFor(() => expect(mockRecord).toHaveBeenCalledTimes(1));
    expect(mockRecord.mock.calls[0][0]).toMatchObject({
      agentGroupId: 'ag-test',
      sessionId: 'sess-test',
      messageId: 'm-1',
      kind: 'task',
      seriesId: 'daily-digest',
      reason: 'claim-stuck',
    });
  });

  it('does not record when the message is only rescheduled with backoff', () => {
    const dbs = makeSessionDbs();
    stuck(dbs, 1, 'chat', null);
    _resetStuckProcessingRowsForTesting(dbs.inDb, dbs.outDb, session(), 'claim-stuck');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('carries a null series for a one-off chat failure', async () => {
    const dbs = makeSessionDbs();
    stuck(dbs, MAX_TRIES, 'chat', null);
    _resetStuckProcessingRowsForTesting(dbs.inDb, dbs.outDb, session(), 'absolute-ceiling');
    await vi.waitFor(() => expect(mockRecord).toHaveBeenCalledTimes(1));
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ kind: 'chat', seriesId: null });
  });

  it('still marks the message failed if recording rejects', async () => {
    mockRecord.mockRejectedValueOnce(new Error('central DB down'));
    const dbs = makeSessionDbs();
    stuck(dbs, MAX_TRIES, 'task', 's1');
    expect(() => _resetStuckProcessingRowsForTesting(dbs.inDb, dbs.outDb, session(), 'claim-stuck')).not.toThrow();
    const row = dbs.inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-1'").get() as { status: string };
    expect(row.status).toBe('failed');
  });
});
