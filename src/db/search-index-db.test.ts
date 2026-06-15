import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSearchIndexSchema,
  deleteByRef,
  getCursor,
  indexRows,
  searchHistory,
  setCursorMtime,
  setCursorSeq,
  type IndexRow,
} from './search-index-db.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  createSearchIndexSchema(db);
});

afterEach(() => {
  db.close();
});

function row(over: Partial<IndexRow>): IndexRow {
  return {
    agentGroupId: 'ag-A',
    source: 'in',
    ref: 'in:s1:m1',
    ts: '2026-06-13T00:00:00Z',
    body: 'the quick brown fox',
    ...over,
  };
}

describe('searchHistory — chokepoint', () => {
  it('returns ranked snippets scoped to the group', () => {
    indexRows(db, [
      row({ ref: 'r1', body: 'deploying the staging server tonight' }),
      row({ ref: 'r2', body: 'the dog ate my homework' }),
    ]);
    const hits = searchHistory(db, 'ag-A', 'staging');
    expect(hits).toHaveLength(1);
    expect(hits[0].ref).toBe('r1');
    expect(hits[0].snippet).toContain('staging');
  });

  it('returns [] for an empty query', () => {
    indexRows(db, [row({})]);
    expect(searchHistory(db, 'ag-A', '   ')).toEqual([]);
  });

  it('honours the limit (clamped to 1..50)', () => {
    for (let i = 0; i < 10; i++) indexRows(db, [row({ ref: `r${i}`, body: `repeat token number ${i}` })]);
    expect(searchHistory(db, 'ag-A', 'token', 3)).toHaveLength(3);
    expect(searchHistory(db, 'ag-A', 'token', 0)).toHaveLength(10); // 0 → default 10
    expect(searchHistory(db, 'ag-A', 'token', 999).length).toBeLessThanOrEqual(10);
  });
});

describe('searchHistory — isolation (cross-group regression)', () => {
  it('a query scoped to group B never sees group A rows', () => {
    indexRows(db, [
      row({ agentGroupId: 'ag-A', ref: 'a1', body: 'secret alpha plans' }),
      row({ agentGroupId: 'ag-B', ref: 'b1', body: 'beta meeting notes' }),
    ]);
    // Group B searches for group A's content — must return nothing.
    expect(searchHistory(db, 'ag-B', 'alpha')).toEqual([]);
    // And only ever sees its own rows.
    const bHits = searchHistory(db, 'ag-B', 'beta');
    expect(bHits).toHaveLength(1);
    expect(bHits[0].ref).toBe('b1');
    // Group A still sees its own.
    expect(searchHistory(db, 'ag-A', 'alpha')).toHaveLength(1);
  });

  it('cannot be widened via an FTS column filter on the unindexed scope column', () => {
    indexRows(db, [row({ agentGroupId: 'ag-A', ref: 'a1', body: 'alpha' })]);
    // A malicious query referencing the scope column is a syntax/no-column
    // error → caught → sanitized; it can never cross the group boundary.
    expect(searchHistory(db, 'ag-B', 'agent_group_id:ag-A')).toEqual([]);
    expect(searchHistory(db, 'ag-B', 'alpha AND agent_group_id:ag-A')).toEqual([]);
  });
});

describe('searchHistory — malformed query safety', () => {
  it('does not throw on FTS-operator garbage; falls back to sanitized tokens', () => {
    indexRows(db, [row({ ref: 'r1', body: 'rollback the migration' })]);
    // Unbalanced quote / stray operators would be an FTS syntax error raw.
    expect(() => searchHistory(db, 'ag-A', 'rollback"')).not.toThrow();
    const hits = searchHistory(db, 'ag-A', 'rollback"');
    expect(hits).toHaveLength(1);
  });

  it('supports valid FTS operators on the raw path', () => {
    indexRows(db, [row({ ref: 'r1', body: 'apple pie recipe' }), row({ ref: 'r2', body: 'banana bread recipe' })]);
    expect(searchHistory(db, 'ag-A', 'apple OR banana')).toHaveLength(2);
  });
});

describe('cursors', () => {
  it('round-trips seq and mtime independently per scope', () => {
    setCursorSeq(db, 'msg-in:s1', 42);
    setCursorMtime(db, 'file:/x.md', 1234.5);
    expect(getCursor(db, 'msg-in:s1').seq).toBe(42);
    expect(getCursor(db, 'file:/x.md').mtime).toBe(1234.5);
    expect(getCursor(db, 'never-set')).toEqual({ seq: null, mtime: null });
  });

  it('upserts on conflict', () => {
    setCursorSeq(db, 'msg-in:s1', 10);
    setCursorSeq(db, 'msg-in:s1', 20);
    expect(getCursor(db, 'msg-in:s1').seq).toBe(20);
  });
});

describe('deleteByRef', () => {
  it('removes only the matching ref within the group', () => {
    indexRows(db, [
      row({ agentGroupId: 'ag-A', ref: '/conv.md', body: 'first version of the file' }),
      row({ agentGroupId: 'ag-B', ref: '/conv.md', body: 'other group same path' }),
    ]);
    deleteByRef(db, 'ag-A', '/conv.md');
    expect(searchHistory(db, 'ag-A', 'version')).toEqual([]);
    expect(searchHistory(db, 'ag-B', 'group')).toHaveLength(1);
  });
});
