/**
 * Two load-bearing guarantees:
 *   1. An outcome round-trips and reads back newest-first, scoped to its group.
 *   2. A missing `task_outcomes` table degrades to a no-op instead of throwing
 *      — this is called from the host sweep's failure path, which must not be
 *      aborted by a DB that predates the migration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { listTaskOutcomes, recordTaskOutcome } from './task-outcomes.js';

const base = { sessionId: 'sess-1', messageId: 'msg-1', reason: 'claim-stuck' };

describe('task outcomes', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
  });
  afterEach(async () => {
    await closeDb();
  });

  it('round-trips an outcome with its defaults applied', async () => {
    await recordTaskOutcome({ ...base, agentGroupId: 'ag-1' });
    const [row] = await listTaskOutcomes('ag-1');
    expect(row.agent_group_id).toBe('ag-1');
    expect(row.reason).toBe('claim-stuck');
    expect(row.status).toBe('failed');
    expect(row.series_id).toBeNull();
    expect(row.kind).toBeNull();
    expect(row.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps series and kind when given, and scopes reads to the group', async () => {
    await recordTaskOutcome({ ...base, agentGroupId: 'ag-1', seriesId: 'daily-digest', kind: 'task' });
    await recordTaskOutcome({ ...base, agentGroupId: 'ag-2', messageId: 'msg-2' });
    const rows = await listTaskOutcomes('ag-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].series_id).toBe('daily-digest');
    expect(rows[0].kind).toBe('task');
  });

  it('returns newest first and honours the limit', async () => {
    for (const id of ['a', 'b', 'c']) {
      await recordTaskOutcome({ ...base, agentGroupId: 'ag-1', messageId: id });
    }
    const rows = await listTaskOutcomes('ag-1', 2);
    expect(rows).toHaveLength(2);
    // Same recorded_at second is likely, so id DESC is the tiebreak that makes
    // "newest first" deterministic.
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
  });

  it('is a no-op when the table is absent, and never throws', async () => {
    await getDb().exec('DROP TABLE task_outcomes');
    await expect(recordTaskOutcome({ ...base, agentGroupId: 'ag-1' })).resolves.toBeUndefined();
    await expect(listTaskOutcomes('ag-1')).resolves.toEqual([]);
  });
});
