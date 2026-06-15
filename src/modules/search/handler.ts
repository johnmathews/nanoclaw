/**
 * Host handler for the `search_history` system action (learning & memory
 * feature #2).
 *
 * The container can't open the host-owned `data/v2-index.db` (it mounts only
 * its own session dir, and a WAL DB over VirtioFS hits the mmap-coherency bug),
 * so search is a round-trip tool — same shape as `remember`: the container
 * writes a `search_history` system action to outbound.db and polls inbound.db
 * for the reply this handler inserts (deterministic id `search-resp-<id>`,
 * trigger=0 so it never wakes the agent).
 *
 * Isolation: the query goes through the single `searchHistory` chokepoint in
 * src/db/search-index-db.ts, always scoped to `session.agent_group_id`. The
 * handler never composes MATCH SQL itself.
 */
import type Database from 'better-sqlite3';

import { insertMessage } from '../../db/session-db.js';
import { getSearchIndexDb, searchHistory, type SearchHit } from '../../db/search-index-db.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface SearchFrame {
  ok: boolean;
  error?: string;
  query?: string;
  results?: SearchHit[];
}

function reply(inDb: Database.Database, requestId: string, frame: SearchFrame): void {
  // trigger=0 — an inline response to a tool call, never wakes the agent.
  insertMessage(inDb, {
    id: `search-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'search_history_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

export async function handleSearchHistory(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = content.requestId as string;
  if (!requestId) {
    log.warn('search_history missing requestId', { sessionId: session.id });
    return;
  }

  const query = typeof content.query === 'string' ? content.query : '';
  const rawLimit = typeof content.limit === 'number' ? content.limit : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.trunc(rawLimit) || DEFAULT_LIMIT), MAX_LIMIT);

  if (!query.trim()) {
    reply(inDb, requestId, { ok: false, error: 'empty_query', query });
    return;
  }

  const indexDb = getSearchIndexDb();
  if (!indexDb) {
    reply(inDb, requestId, { ok: false, error: 'index_unavailable', query });
    log.warn('search_history: index DB not initialized', { sessionId: session.id });
    return;
  }

  try {
    const results = searchHistory(indexDb, session.agent_group_id, query, limit);
    reply(inDb, requestId, { ok: true, query, results });
    log.info('search_history served', { sessionId: session.id, hits: results.length });
  } catch (err) {
    reply(inDb, requestId, { ok: false, error: 'search_failed', query });
    log.warn('search_history failed', { sessionId: session.id, error: String(err) });
  }
}
