/**
 * Host handler for the `search_history` system action.
 *
 * The container can't open the host-owned `data/v2-index.db` (it mounts only
 * its own session dir, and a WAL DB over VirtioFS hits the mmap-coherency
 * bug), so search is a round-trip tool: the container writes a
 * `search_history` system action to its outbound mailbox and polls inbound for
 * the reply this handler writes — deterministic id `search-resp-<id>`, and
 * `trigger: false` so it never wakes the agent. It rides along on the agent's
 * next real turn.
 *
 * Isolation: the query goes through the single `searchHistory` chokepoint in
 * src/db/search-index-db.ts, always scoped to `session.agent_group_id`. This
 * handler never composes MATCH SQL itself.
 */
import { getSearchIndexDb, searchHistory, type SearchHit } from '../../db/search-index-db.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface SearchFrame {
  ok: boolean;
  error?: string;
  query?: string;
  results?: SearchHit[];
}

async function reply(session: Session, requestId: string, frame: SearchFrame): Promise<void> {
  // trigger: false — an inline response to a tool call, never wakes the agent.
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `search-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ type: 'search_history_response', requestId, frame }),
    trigger: false,
  });
}

export async function handleSearchHistory(content: Record<string, unknown>, session: Session): Promise<void> {
  const requestId = content.requestId as string;
  if (!requestId) {
    log.warn('search_history missing requestId', { sessionId: session.id });
    return;
  }

  const query = typeof content.query === 'string' ? content.query : '';
  const rawLimit = typeof content.limit === 'number' ? content.limit : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.trunc(rawLimit) || DEFAULT_LIMIT), MAX_LIMIT);

  if (!query.trim()) {
    await reply(session, requestId, { ok: false, error: 'empty_query', query });
    return;
  }

  const indexDb = getSearchIndexDb();
  if (!indexDb) {
    await reply(session, requestId, { ok: false, error: 'index_unavailable', query });
    log.warn('search_history: index DB not initialized', { sessionId: session.id });
    return;
  }

  try {
    const results = searchHistory(indexDb, session.agent_group_id, query, limit);
    await reply(session, requestId, { ok: true, query, results });
    log.info('search_history served', { sessionId: session.id, hits: results.length });
  } catch (err) {
    await reply(session, requestId, { ok: false, error: 'search_failed', query });
    log.warn('search_history failed', { sessionId: session.id, error: String(err) });
  }
}
