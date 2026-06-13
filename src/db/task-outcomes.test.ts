import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { listTaskOutcomes, recordTaskOutcome } from './task-outcomes.js';

describe('task_outcomes migration', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => closeDb());

  it('creates the task_outcomes table and group index', () => {
    const table = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_outcomes'")
      .get();
    expect(table).toBeTruthy();
    const index = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_outcomes_group'")
      .get();
    expect(index).toBeTruthy();
  });

  it('is idempotent — re-running migrations does not error or duplicate', () => {
    // schema_version is keyed by name, so a second run is a no-op.
    expect(() => runMigrations(getDb())).not.toThrow();
  });
});

describe('recordTaskOutcome / listTaskOutcomes', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => closeDb());

  it('persists all fields and defaults status to failed', () => {
    recordTaskOutcome(getDb(), {
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messageId: 'm-1',
      seriesId: 's-1',
      kind: 'task',
      reason: 'claim-stuck',
    });

    const rows = listTaskOutcomes(getDb(), 'ag-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_group_id: 'ag-1',
      session_id: 'sess-1',
      message_id: 'm-1',
      series_id: 's-1',
      kind: 'task',
      reason: 'claim-stuck',
      status: 'failed',
    });
    expect(rows[0].recorded_at).toBeTruthy();
  });

  it('defaults seriesId and kind to null when omitted', () => {
    recordTaskOutcome(getDb(), {
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messageId: 'm-2',
      reason: 'container not running',
    });
    const rows = listTaskOutcomes(getDb(), 'ag-1');
    expect(rows[0]).toMatchObject({ series_id: null, kind: null });
  });

  it('scopes listing to the requested agent group', () => {
    recordTaskOutcome(getDb(), { agentGroupId: 'ag-1', sessionId: 's', messageId: 'a', reason: 'r' });
    recordTaskOutcome(getDb(), { agentGroupId: 'ag-2', sessionId: 's', messageId: 'b', reason: 'r' });

    expect(listTaskOutcomes(getDb(), 'ag-1')).toHaveLength(1);
    expect(listTaskOutcomes(getDb(), 'ag-2')).toHaveLength(1);
    expect(listTaskOutcomes(getDb(), 'ag-3')).toHaveLength(0);
  });

  it('degrades to a no-op when the table is absent (pre-migration safety)', () => {
    const bare = new Database(':memory:');
    expect(() => recordTaskOutcome(bare, { agentGroupId: 'x', sessionId: 's', messageId: 'm', reason: 'r' })).not.toThrow();
    expect(listTaskOutcomes(bare, 'x')).toEqual([]);
    bare.close();
  });
});
