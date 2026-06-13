import type Database from 'better-sqlite3';

import { hasTable } from './connection.js';

export interface TaskOutcomeInput {
  agentGroupId: string;
  sessionId: string;
  messageId: string;
  /** Recurring-task series id (NULL for one-off / chat messages). */
  seriesId?: string | null;
  /** messages_in.kind — 'task', 'chat', etc. Lets readers filter task failures. */
  kind?: string | null;
  /** What went wrong: the host-sweep failure reason ('claim-stuck', etc.). */
  reason: string;
  /** Defaults to 'failed'. Reserved for future 'succeeded' bookkeeping. */
  status?: string;
}

export interface TaskOutcomeRow {
  id: number;
  agent_group_id: string;
  session_id: string;
  message_id: string;
  series_id: string | null;
  kind: string | null;
  reason: string;
  status: string;
  recorded_at: string;
}

/**
 * Persist a task/message outcome to the central `task_outcomes` table. Caller
 * passes the DB explicitly (host sweep passes `getDb()`) so this stays unit
 * testable. Guards on table presence so a pre-migration call degrades to a
 * no-op rather than throwing — the failure path that calls this must never be
 * aborted by a missing table.
 */
export function recordTaskOutcome(db: Database.Database, outcome: TaskOutcomeInput): void {
  if (!hasTable(db, 'task_outcomes')) return;
  db.prepare(
    `INSERT INTO task_outcomes (agent_group_id, session_id, message_id, series_id, kind, reason, status, recorded_at)
     VALUES (@agentGroupId, @sessionId, @messageId, @seriesId, @kind, @reason, @status, @recordedAt)`,
  ).run({
    agentGroupId: outcome.agentGroupId,
    sessionId: outcome.sessionId,
    messageId: outcome.messageId,
    seriesId: outcome.seriesId ?? null,
    kind: outcome.kind ?? null,
    reason: outcome.reason,
    status: outcome.status ?? 'failed',
    recordedAt: new Date().toISOString(),
  });
}

/** Most-recent-first outcomes for an agent group. Used by reflection/reporting. */
export function listTaskOutcomes(db: Database.Database, agentGroupId: string, limit = 50): TaskOutcomeRow[] {
  if (!hasTable(db, 'task_outcomes')) return [];
  return db
    .prepare(`SELECT * FROM task_outcomes WHERE agent_group_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?`)
    .all(agentGroupId, limit) as TaskOutcomeRow[];
}
