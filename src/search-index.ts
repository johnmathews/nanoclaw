/**
 * Conversation-history indexing (learning & memory layer, feature #2).
 *
 * Population side of the FTS5 search index. Runs inside the 60s host sweep
 * (src/host-sweep.ts), which already opens each session's inbound/outbound DBs,
 * and pulls *new* material incrementally:
 *
 *   - messages_in  (user messages)  — incremental by seq
 *   - messages_out (agent replies)  — incremental by seq
 *   - groups/<folder>/conversations/*.md (PreCompact archives written by
 *     container/agent-runner/src/providers/claude.ts) — incremental by mtime
 *
 * Each tick is capped so a large backlog drains over several sweeps rather than
 * stalling the sweep loop. All work is best-effort: a failure here must never
 * abort the sweep (indexing is a secondary, non-load-bearing write).
 *
 * The query side lives in src/db/search-index-db.ts (the searchHistory
 * chokepoint); this module never reads the index.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import {
  deleteByRef,
  getCursor,
  indexRows,
  setCursorMtime,
  setCursorSeq,
  type IndexRow,
} from './db/search-index-db.js';
import { log } from './log.js';

/** Max message rows pulled from each stream per session per tick. */
const MESSAGES_PER_TICK = 500;
/** Max conversation files (re)indexed per session per tick. */
const FILES_PER_TICK = 25;

/**
 * Pull the searchable text out of a session-DB message `content` blob. Chat
 * messages are `{ text: "..." }`; richer payloads may carry other shapes. We
 * only index human-readable prose, so anything without a string `text` (system
 * actions, structured cards) yields '' and is skipped.
 */
function extractText(raw: string): string {
  try {
    const c = JSON.parse(raw);
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string') {
      return (c as { text: string }).text;
    }
    return '';
  } catch {
    return '';
  }
}

interface MessageDbRow {
  seq: number | null;
  id: string;
  kind: string;
  timestamp: string;
  content: string;
}

/**
 * Index new rows from one message stream (inbound or outbound) incrementally by
 * seq. Advances the cursor to the highest seq *seen* this tick — even for rows
 * whose text was empty and skipped — so empties are never re-scanned. Returns
 * the number of FTS rows written.
 */
function indexMessageStream(
  indexDb: Database.Database,
  sessionDb: Database.Database,
  table: 'messages_in' | 'messages_out',
  source: 'in' | 'out',
  agentGroupId: string,
  sessionId: string,
): number {
  const scope = `${source === 'in' ? 'msg-in' : 'msg-out'}:${sessionId}`;
  const cursor = getCursor(indexDb, scope).seq ?? 0;

  const rows = sessionDb
    .prepare(
      `SELECT seq, id, kind, timestamp, content FROM ${table}
        WHERE seq IS NOT NULL AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .all(cursor, MESSAGES_PER_TICK) as MessageDbRow[];

  if (rows.length === 0) return 0;

  const toIndex: IndexRow[] = [];
  let maxSeq = cursor;
  for (const r of rows) {
    if (r.seq !== null && r.seq > maxSeq) maxSeq = r.seq;
    if (r.kind === 'system') continue;
    const body = extractText(r.content);
    if (!body.trim()) continue;
    toIndex.push({ agentGroupId, source, ref: `${source}:${sessionId}:${r.id}`, ts: r.timestamp, body });
  }

  indexRows(indexDb, toIndex);
  setCursorSeq(indexDb, scope, maxSeq);
  return toIndex.length;
}

/**
 * Index the agent group's archived conversation transcripts. Each file is
 * write-once-per-compaction with a timestamped name, but we key on mtime so a
 * rewrite re-indexes cleanly (delete-by-ref then insert — no duplicates).
 * Returns the number of files (re)indexed.
 */
function indexConversationFiles(indexDb: Database.Database, conversationsDir: string, agentGroupId: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(conversationsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return 0; // dir absent — group hasn't compacted yet
  }

  let count = 0;
  for (const name of entries.sort()) {
    if (count >= FILES_PER_TICK) break;
    const filePath = path.join(conversationsDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const scope = `file:${filePath}`;
    const lastMtime = getCursor(indexDb, scope).mtime ?? 0;
    if (stat.mtimeMs <= lastMtime) continue; // unchanged since last index

    let body: string;
    try {
      body = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    deleteByRef(indexDb, agentGroupId, filePath);
    if (body.trim()) {
      indexRows(indexDb, [
        { agentGroupId, source: 'conversation', ref: filePath, ts: new Date(stat.mtimeMs).toISOString(), body },
      ]);
    }
    setCursorMtime(indexDb, scope, stat.mtimeMs);
    count++;
  }
  return count;
}

export interface IndexSessionArgs {
  indexDb: Database.Database;
  inDb: Database.Database;
  outDb: Database.Database | null;
  agentGroupId: string;
  sessionId: string;
  conversationsDir: string;
}

/**
 * Index everything new for one session this tick: inbound messages, outbound
 * replies (if outbound.db is open), and conversation archives. Pure-ish —
 * caller supplies all DB handles + paths; never throws (each sub-step is
 * independently guarded by the caller's try/catch in the sweep).
 */
export function indexSession(args: IndexSessionArgs): void {
  const { indexDb, inDb, outDb, agentGroupId, sessionId, conversationsDir } = args;
  const inCount = indexMessageStream(indexDb, inDb, 'messages_in', 'in', agentGroupId, sessionId);
  const outCount = outDb ? indexMessageStream(indexDb, outDb, 'messages_out', 'out', agentGroupId, sessionId) : 0;
  const fileCount = indexConversationFiles(indexDb, conversationsDir, agentGroupId);
  if (inCount + outCount + fileCount > 0) {
    log.info('Indexed conversation history', { sessionId, inCount, outCount, fileCount });
  }
}
