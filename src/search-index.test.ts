import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSearchIndexSchema, searchHistory } from './db/search-index-db.js';
import { indexSession } from './search-index.js';

let indexDb: Database.Database;
let inDb: Database.Database;
let outDb: Database.Database;
let convDir: string;

const AG = 'ag-1';
const SESS = 's1';

function makeInbound(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages_in (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL,
    timestamp TEXT NOT NULL, content TEXT NOT NULL
  );`);
  return db;
}

function makeOutbound(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages_out (
    id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL,
    timestamp TEXT NOT NULL, content TEXT NOT NULL
  );`);
  return db;
}

function insIn(seq: number, kind: string, text: unknown): void {
  inDb
    .prepare('INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)')
    .run(`in${seq}`, seq, kind, '2026-06-13T00:00:00Z', typeof text === 'string' ? text : JSON.stringify(text));
}

function insOut(seq: number, kind: string, text: unknown): void {
  outDb
    .prepare('INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES (?, ?, ?, ?, ?)')
    .run(`out${seq}`, seq, kind, '2026-06-13T00:00:00Z', typeof text === 'string' ? text : JSON.stringify(text));
}

function run(): void {
  indexSession({ indexDb, inDb, outDb, agentGroupId: AG, sessionId: SESS, conversationsDir: convDir });
}

beforeEach(() => {
  indexDb = new Database(':memory:');
  createSearchIndexSchema(indexDb);
  inDb = makeInbound();
  outDb = makeOutbound();
  convDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
});

afterEach(() => {
  indexDb.close();
  inDb.close();
  outDb.close();
  fs.rmSync(convDir, { recursive: true, force: true });
});

describe('indexSession — messages', () => {
  it('indexes inbound + outbound text, tagging the source', () => {
    insIn(2, 'chat', { text: 'when does the migration run' });
    insOut(3, 'chat', { text: 'the migration runs at midnight' });
    run();

    const hits = searchHistory(indexDb, AG, 'migration');
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.source))).toEqual(new Set(['in', 'out']));
  });

  it('skips system messages and empty/structured payloads', () => {
    insIn(2, 'system', { action: 'search_history', query: 'migration' });
    insIn(4, 'chat', { foo: 'bar' }); // no text field
    insOut(3, 'system', { action: 'remember' });
    run();
    expect(searchHistory(indexDb, AG, 'migration')).toEqual([]);
    expect(searchHistory(indexDb, AG, 'bar')).toEqual([]);
  });

  it('is incremental by seq — re-running does not duplicate', () => {
    insIn(2, 'chat', { text: 'unique alpha token' });
    run();
    run(); // second sweep, no new rows
    expect(searchHistory(indexDb, AG, 'alpha')).toHaveLength(1);

    insIn(4, 'chat', { text: 'second alpha message' });
    run();
    expect(searchHistory(indexDb, AG, 'alpha')).toHaveLength(2);
  });

  it('tolerates a null outbound DB', () => {
    insIn(2, 'chat', { text: 'inbound only beta' });
    indexSession({ indexDb, inDb, outDb: null, agentGroupId: AG, sessionId: SESS, conversationsDir: convDir });
    expect(searchHistory(indexDb, AG, 'beta')).toHaveLength(1);
  });
});

describe('indexSession — conversation files', () => {
  it('indexes *.md archives and tags them as conversation', () => {
    fs.writeFileSync(path.join(convDir, '2026-06-13-planning.md'), '# Planning\n\nWe decided to ship gamma on Friday.');
    run();
    const hits = searchHistory(indexDb, AG, 'gamma');
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('conversation');
  });

  it('does not re-index an unchanged file (no duplicates)', () => {
    const f = path.join(convDir, 'a.md');
    fs.writeFileSync(f, 'delta epsilon content');
    run();
    run();
    expect(searchHistory(indexDb, AG, 'delta')).toHaveLength(1);
  });

  it('re-indexes a changed file in place (delete-by-ref, no duplicate)', () => {
    const f = path.join(convDir, 'a.md');
    fs.writeFileSync(f, 'original zeta text');
    run();
    // Bump mtime forward and rewrite with new content.
    const future = Date.now() + 5000;
    fs.writeFileSync(f, 'revised zeta text plus eta');
    fs.utimesSync(f, new Date(future), new Date(future));
    run();
    const hits = searchHistory(indexDb, AG, 'zeta');
    expect(hits).toHaveLength(1); // not duplicated
    expect(searchHistory(indexDb, AG, 'eta')).toHaveLength(1); // sees new content
  });

  it('no-ops cleanly when the conversations dir is absent', () => {
    fs.rmSync(convDir, { recursive: true, force: true });
    expect(() => run()).not.toThrow();
  });
});
