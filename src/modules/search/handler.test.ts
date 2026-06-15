import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeSearchIndexDb, indexRows, initSearchIndexDb } from '../../db/search-index-db.js';
import type { Session } from '../../types.js';
import { handleSearchHistory } from './handler.js';

let inDb: Database.Database;

function makeInbound(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
    status TEXT DEFAULT 'pending', platform_id TEXT, channel_type TEXT, thread_id TEXT,
    content TEXT NOT NULL, process_after TEXT, recurrence TEXT, series_id TEXT,
    tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, source_session_id TEXT,
    on_wake INTEGER NOT NULL DEFAULT 0
  );`);
  return db;
}

function session(agentGroupId = 'ag-A'): Session {
  return {
    id: 'sess-1',
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

function replyRow(requestId: string): { content: string; trigger: number } | undefined {
  return inDb.prepare('SELECT content, trigger FROM messages_in WHERE id = ?').get(`search-resp-${requestId}`) as
    | { content: string; trigger: number }
    | undefined;
}

function frameOf(requestId: string): Record<string, unknown> {
  const row = replyRow(requestId);
  if (!row) throw new Error('no reply written');
  return JSON.parse(row.content).frame;
}

beforeEach(() => {
  inDb = makeInbound();
  const idx = initSearchIndexDb(':memory:');
  indexRows(idx, [
    { agentGroupId: 'ag-A', source: 'in', ref: 'a1', ts: '2026-06-13T00:00:00Z', body: 'discuss the rollout plan' },
    { agentGroupId: 'ag-B', source: 'in', ref: 'b1', ts: '2026-06-13T00:00:00Z', body: 'rollout for the other group' },
  ]);
});

afterEach(() => {
  inDb.close();
  closeSearchIndexDb();
});

describe('handleSearchHistory', () => {
  it('writes a trigger=0 reply with scoped results', async () => {
    await handleSearchHistory({ requestId: 'req1', query: 'rollout' }, session('ag-A'), inDb);
    const row = replyRow('req1');
    expect(row?.trigger).toBe(0);
    const frame = frameOf('req1');
    expect(frame.ok).toBe(true);
    const results = frame.results as Array<{ ref: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].ref).toBe('a1'); // only group A's row
  });

  it('rejects an empty query', async () => {
    await handleSearchHistory({ requestId: 'req2', query: '   ' }, session(), inDb);
    expect(frameOf('req2')).toMatchObject({ ok: false, error: 'empty_query' });
  });

  it('reports index_unavailable when the index DB is not initialized', async () => {
    closeSearchIndexDb();
    await handleSearchHistory({ requestId: 'req3', query: 'rollout' }, session(), inDb);
    expect(frameOf('req3')).toMatchObject({ ok: false, error: 'index_unavailable' });
  });

  it('does nothing without a requestId', async () => {
    await handleSearchHistory({ query: 'rollout' }, session(), inDb);
    const count = inDb.prepare('SELECT COUNT(*) c FROM messages_in').get() as { c: number };
    expect(count.c).toBe(0);
  });
});
