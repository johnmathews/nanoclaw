/**
 * Host handler for the `remember` system action (learning & memory feature #1).
 *
 * The container's `remember` MCP tool can't hold the authoritative MEMORY.md /
 * USER.md text (the composed CLAUDE.md is RO-overlaid, and the host is the
 * single writer of these source files), so it's a round-trip tool: the
 * container writes a `remember` system action to outbound.db and polls
 * inbound.db for the reply this handler inserts.
 *
 * On a successful edit we recompose CLAUDE.md so the next spawn picks up the
 * new frozen snapshot. We do NOT restart the running container (decision Q1,
 * "defer"): the writing session already holds the fact in context — it had to
 * produce the text to call the tool — so the snapshot only matters next time.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { composeGroupClaudeMd } from '../../claude-md-compose.js';
import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { applyMemoryOp, type MemoryOp } from './budget.js';

const DEFAULT_MEMORY_BUDGET = 2200;
const DEFAULT_USER_BUDGET = 1375;

const TARGET_FILES: Record<string, string> = { memory: 'MEMORY.md', user: 'USER.md' };

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function reply(inDb: Database.Database, requestId: string, frame: Record<string, unknown>): void {
  // trigger=0 — an inline response to a tool call, never wakes the agent.
  insertMessage(inDb, {
    id: `rem-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'remember_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

export async function handleRemember(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = content.requestId as string;
  const target = content.target as string;
  const op = content.op as MemoryOp;

  if (!requestId) {
    log.warn('remember missing requestId', { sessionId: session.id });
    return;
  }
  if (!TARGET_FILES[target]) {
    reply(inDb, requestId, { ok: false, target, op, error: 'invalid_target' });
    return;
  }

  const group = getAgentGroup(session.agent_group_id);
  if (!group) {
    reply(inDb, requestId, { ok: false, target, op, error: 'group_not_found' });
    return;
  }

  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const filePath = path.join(groupDir, TARGET_FILES[target]);
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

  const cfg = getContainerConfig(session.agent_group_id);
  const budget =
    target === 'user'
      ? cfg?.user_budget_chars ?? DEFAULT_USER_BUDGET
      : cfg?.memory_budget_chars ?? DEFAULT_MEMORY_BUDGET;

  const result = applyMemoryOp(
    current,
    op,
    {
      text: content.text as string | undefined,
      match: content.match as string | undefined,
      replacement: content.replacement as string | undefined,
    },
    budget,
  );

  if (!result.ok) {
    // Hand the current entries back so the agent can consolidate/evict.
    reply(inDb, requestId, {
      ok: false,
      target,
      op,
      error: result.error,
      current,
      chars: result.chars,
      budget: result.budget,
    });
    log.info('remember rejected', { sessionId: session.id, target, op, error: result.error });
    return;
  }

  try {
    if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });
    writeAtomic(filePath, result.content ?? '');
    // Recompose so the next spawn injects the new snapshot (defer — no restart).
    composeGroupClaudeMd(group);
  } catch (err) {
    reply(inDb, requestId, { ok: false, target, op, error: 'write_failed' });
    log.warn('remember write failed', { sessionId: session.id, target, op, error: String(err) });
    return;
  }

  reply(inDb, requestId, { ok: true, target, op, chars: result.chars, budget: result.budget });
  log.info('remember applied', { sessionId: session.id, target, op, chars: result.chars });
}
