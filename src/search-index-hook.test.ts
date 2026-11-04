/**
 * The hook runs inside reconcileSession, which owns session liveness — so the
 * contract that matters is that it never disturbs that pass. Each guard here
 * is a way the hook could otherwise throw into the reconcile path: no index
 * initialized, an unknown group, a session whose mailbox files do not exist
 * yet, or a missing outbound side.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => Promise.resolve(id === 'ag-known' ? { id, folder: 'grp', name: id } : null),
}));
vi.mock('./mailbox/sqlite/paths.js', () => ({
  inboundDbPath: (_a: string, s: string) => path.join(tmp, `${s}-inbound.db`),
  outboundDbPath: (_a: string, s: string) => path.join(tmp, `${s}-outbound.db`),
}));

import { closeSearchIndexDb, getSearchIndexDb, initSearchIndexDb, searchHistory } from './db/search-index-db.js';
import { indexSessionBestEffort } from './search-index-hook.js';

/** A session inbound DB shaped like the real one, with one chat row. */
function makeInbound(file: string, body: string): void {
  const db = new Database(file);
  db.exec(`CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, seq INTEGER, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
    status TEXT DEFAULT 'pending', platform_id TEXT, channel_type TEXT, thread_id TEXT,
    content TEXT NOT NULL, process_after TEXT, recurrence TEXT, series_id TEXT,
    tries INTEGER DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1, source_session_id TEXT,
    on_wake INTEGER NOT NULL DEFAULT 0
  );`);
  db.prepare('INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)').run(
    'm1',
    2,
    'chat',
    '2026-11-04T00:00:00Z',
    JSON.stringify({ text: body, sender: 'john' }),
  );
  db.close();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-index-hook-'));
});
afterEach(() => {
  closeSearchIndexDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('indexSessionBestEffort', () => {
  it('indexes an inbound row so search_history can find it', async () => {
    initSearchIndexDb(':memory:');
    makeInbound(path.join(tmp, 'sess-1-inbound.db'), 'the quarterly rollout plan');
    await indexSessionBestEffort('ag-known', 'sess-1');
    const hits = searchHistory(getSearchIndexDb()!, 'ag-known', 'rollout');
    expect(hits.length).toBe(1);
  });

  it('is a no-op when no index DB is initialized', async () => {
    makeInbound(path.join(tmp, 'sess-1-inbound.db'), 'rollout');
    await expect(indexSessionBestEffort('ag-known', 'sess-1')).resolves.toBeUndefined();
  });

  it('is a no-op for an unknown agent group', async () => {
    initSearchIndexDb(':memory:');
    makeInbound(path.join(tmp, 'sess-1-inbound.db'), 'rollout');
    await indexSessionBestEffort('ag-missing', 'sess-1');
    expect(searchHistory(getSearchIndexDb()!, 'ag-missing', 'rollout')).toEqual([]);
  });

  it('is a no-op when the session mailbox does not exist yet', async () => {
    initSearchIndexDb(':memory:');
    await expect(indexSessionBestEffort('ag-known', 'sess-nope')).resolves.toBeUndefined();
  });

  it('indexes with the outbound side absent', async () => {
    initSearchIndexDb(':memory:');
    makeInbound(path.join(tmp, 'sess-2-inbound.db'), 'only inbound here');
    await indexSessionBestEffort('ag-known', 'sess-2');
    expect(searchHistory(getSearchIndexDb()!, 'ag-known', 'inbound').length).toBe(1);
  });

  it('leaves no session DB handles open (temp dir is removable)', async () => {
    initSearchIndexDb(':memory:');
    makeInbound(path.join(tmp, 'sess-3-inbound.db'), 'handles');
    await indexSessionBestEffort('ag-known', 'sess-3');
    expect(() => fs.rmSync(tmp, { recursive: true })).not.toThrow();
    fs.mkdirSync(tmp, { recursive: true });
  });
});
