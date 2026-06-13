/**
 * Conversation search index (learning & memory layer, feature #2).
 *
 * A third host-owned SQLite file — `data/v2-index.db` — distinct from the
 * central `data/v2.db` and the per-session inbound/outbound DBs. The host is
 * its sole writer. It holds an FTS5 full-text index of conversation history
 * (user messages, agent replies, and archived `conversations/*.md`) keyed by
 * `agent_group_id`, plus a per-scope cursor table for incremental indexing.
 *
 * Isolation (decision Q3 in docs/plan-learning-and-memory.md). The index is a
 * *shared* file scoped by an `agent_group_id` column rather than a per-group
 * file, so the scope must be impossible to forget. Every read goes through the
 * single chokepoint `searchHistory(db, groupId, …)`, which always ANDs
 * `agent_group_id = ?` onto the MATCH. No caller composes raw MATCH SQL. A
 * cross-group regression test (search-index-db.test.ts) asserts a query scoped
 * to group B can never see group A's rows.
 *
 * Cross-mount: the container can NEVER open this file — it only mounts its own
 * session dir, and a host-written WAL DB would hit the VirtioFS mmap-coherency
 * bug (docs/db.md §4). `search_history` is therefore a round-trip tool: the
 * container asks, the host queries here and writes the reply back to inbound.db.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

/** A row to index into the FTS table. `body` is the searchable text. */
export interface IndexRow {
  agentGroupId: string;
  /** Provenance: 'in' (user msg), 'out' (agent reply), 'conversation' (archive). */
  source: string;
  /** Stable identity of the indexed unit — message id or conversation file path. */
  ref: string;
  /** ISO timestamp for display/ordering context. */
  ts: string;
  body: string;
}

/** A single search hit returned to the agent. */
export interface SearchHit {
  source: string;
  ref: string;
  ts: string;
  snippet: string;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/**
 * Create the FTS5 + cursor schema. Idempotent. Exported so tests can build an
 * in-memory index DB without going through the file-backed singleton.
 *
 * Column order matters: `snippet(messages_fts, 4, …)` in searchHistory targets
 * the `body` column by ordinal (0-based), so `body` must stay last.
 */
export function createSearchIndexSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      agent_group_id UNINDEXED,
      source         UNINDEXED,
      ref            UNINDEXED,
      ts             UNINDEXED,
      body
    );

    -- Per-scope incremental-indexing cursors. One row per (message stream) or
    -- (conversation file). seq advances for message scopes; mtime (ms) for
    -- file scopes. Keeps each sweep tick from re-scanning already-indexed data.
    CREATE TABLE IF NOT EXISTS index_cursors (
      scope   TEXT PRIMARY KEY,
      seq     INTEGER,
      mtime   REAL,
      updated TEXT NOT NULL
    );
  `);
}

let _indexDb: Database.Database | null = null;

/**
 * Open (and migrate) the host-owned index DB at `dbPath`, storing it as the
 * process singleton. WAL like the central DB — host is the only writer, and
 * this file is never mounted into a container.
 */
export function initSearchIndexDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _indexDb = new Database(dbPath);
  _indexDb.pragma('journal_mode = WAL');
  createSearchIndexSchema(_indexDb);
  log.info('Search index DB initialized', { path: dbPath });
  return _indexDb;
}

/**
 * The index DB singleton, or null if indexing isn't enabled (e.g. boot failed,
 * or a test/host path that never called initSearchIndexDb). Callers MUST treat
 * null as "search unavailable" and degrade gracefully — never throw on the
 * load-bearing sweep/delivery paths.
 */
export function getSearchIndexDb(): Database.Database | null {
  return _indexDb;
}

export function closeSearchIndexDb(): void {
  _indexDb?.close();
  _indexDb = null;
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

export interface Cursor {
  seq: number | null;
  mtime: number | null;
}

export function getCursor(db: Database.Database, scope: string): Cursor {
  const row = db.prepare('SELECT seq, mtime FROM index_cursors WHERE scope = ?').get(scope) as
    | { seq: number | null; mtime: number | null }
    | undefined;
  return { seq: row?.seq ?? null, mtime: row?.mtime ?? null };
}

export function setCursorSeq(db: Database.Database, scope: string, seq: number): void {
  db.prepare(
    `INSERT INTO index_cursors (scope, seq, updated) VALUES (?, ?, datetime('now'))
     ON CONFLICT(scope) DO UPDATE SET seq = excluded.seq, updated = excluded.updated`,
  ).run(scope, seq);
}

export function setCursorMtime(db: Database.Database, scope: string, mtime: number): void {
  db.prepare(
    `INSERT INTO index_cursors (scope, mtime, updated) VALUES (?, ?, datetime('now'))
     ON CONFLICT(scope) DO UPDATE SET mtime = excluded.mtime, updated = excluded.updated`,
  ).run(scope, mtime);
}

// ---------------------------------------------------------------------------
// Writes (host-only)
// ---------------------------------------------------------------------------

/** Insert FTS rows. No-op on empty input. Wrapped in a single transaction. */
export function indexRows(db: Database.Database, rows: IndexRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    'INSERT INTO messages_fts (agent_group_id, source, ref, ts, body) VALUES (@agentGroupId, @source, @ref, @ts, @body)',
  );
  const tx = db.transaction((batch: IndexRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  tx(rows);
}

/**
 * Remove every FTS row for a given `ref` (used to re-index a changed
 * conversation file without duplicating it). Scoped by group too, so a ref
 * collision across groups can't delete another group's rows.
 */
export function deleteByRef(db: Database.Database, agentGroupId: string, ref: string): void {
  db.prepare('DELETE FROM messages_fts WHERE agent_group_id = ? AND ref = ?').run(agentGroupId, ref);
}

// ---------------------------------------------------------------------------
// Reads — THE single chokepoint
// ---------------------------------------------------------------------------

/**
 * Turn an arbitrary query string into a syntactically-safe FTS5 MATCH
 * expression: bare alphanumeric/underscore tokens, each quoted, ANDed. Strips
 * every FTS operator so it can never throw. Returns '' when no usable token
 * remains.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(' ');
}

/**
 * THE only function that composes an FTS MATCH read. Isolation invariant: the
 * `agent_group_id = @g` predicate is ALWAYS present and is independent of the
 * (untrusted) query text — `agent_group_id` is an UNINDEXED column, so no MATCH
 * expression can reference it to widen the scope. A malformed query can only
 * throw a syntax error, which we catch and retry with a sanitized form; it can
 * never cross the group boundary.
 *
 * Tries the raw query first (so an agent can use FTS operators like OR or exact
 * "phrases"); on a syntax error falls back to the sanitized token form.
 */
export function searchHistory(
  db: Database.Database,
  agentGroupId: string,
  query: string,
  limit: number = DEFAULT_LIMIT,
): SearchHit[] {
  const q = (query ?? '').trim();
  if (!q) return [];
  const lim = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_LIMIT), MAX_LIMIT);

  const stmt = db.prepare(
    `SELECT source, ref, ts, snippet(messages_fts, 4, '«', '»', '…', 12) AS snippet
       FROM messages_fts
      WHERE messages_fts MATCH @m AND agent_group_id = @g
      ORDER BY rank
      LIMIT @l`,
  );

  try {
    return stmt.all({ m: q, g: agentGroupId, l: lim }) as SearchHit[];
  } catch {
    const safe = sanitizeFtsQuery(q);
    if (!safe) return [];
    try {
      return stmt.all({ m: safe, g: agentGroupId, l: lim }) as SearchHit[];
    } catch {
      return [];
    }
  }
}
