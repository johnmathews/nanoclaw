/**
 * Per-session indexing hook for `search_history`.
 *
 * The fork used to index inside the host sweep, which held the session DB
 * handles already. Upstream's sweep no longer does: it enqueues per-session
 * keys and the work happens in reconcileSession, behind the mailbox
 * abstraction. So this hook sources its own read-only handles by path
 * (mailbox/sqlite/paths.ts is the one place that knows the layout) and keeps
 * the reach-in to reconcileSession a single line.
 *
 * Best-effort by construction: an uninitialized index, a session whose DBs do
 * not exist yet, or any failure here must never disturb the reconcile pass
 * that owns session liveness.
 */
import Database from 'better-sqlite3';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getSearchIndexDb } from './db/search-index-db.js';
import { log } from './log.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { indexSession } from './search-index.js';

function openReadOnly(file: string): Database.Database | null {
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/** Index whatever is new for one session. Never throws. */
export async function indexSessionBestEffort(agentGroupId: string, sessionId: string): Promise<void> {
  const indexDb = getSearchIndexDb();
  if (!indexDb) return;

  let inDb: Database.Database | null = null;
  let outDb: Database.Database | null = null;
  try {
    const group = await getAgentGroup(agentGroupId);
    if (!group) return;

    inDb = openReadOnly(inboundDbPath(agentGroupId, sessionId));
    if (!inDb) return; // session mailbox not created yet — nothing to index
    outDb = openReadOnly(outboundDbPath(agentGroupId, sessionId));

    indexSession({
      indexDb,
      inDb,
      outDb,
      agentGroupId,
      sessionId,
      conversationsDir: path.join(GROUPS_DIR, group.folder, 'conversations'),
    });
  } catch (err) {
    log.warn('Conversation indexing failed', { sessionId, err });
  } finally {
    inDb?.close();
    outDb?.close();
  }
}
