/**
 * Task outcome log.
 *
 * When a message exhausts its retries the host sweep marks it failed but
 * historically threw the *reason* away — it only reached `log.warn`. These
 * rows persist the reason plus context so operators (and a reflection pass)
 * can see what went wrong over time instead of a bare `status='failed'`.
 *
 * Distinct from `src/modules/scheduling/run-log.ts`, which appends a
 * human-readable narrative to `groups/<folder>/tasks/<series>.md` written by
 * the agent and by a task run's final text. This table records host-detected
 * failures the agent cannot log itself, machine-readably.
 */
import { getDb } from './connection.js';

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
 * Persist one outcome. Guards on table presence so a pre-migration call
 * degrades to a no-op rather than throwing: the failure path that calls this
 * must never be aborted by a missing table.
 */
export async function recordTaskOutcome(outcome: TaskOutcomeInput): Promise<void> {
  const db = getDb();
  if (!(await db.hasTable('task_outcomes'))) return;
  await db.run(
    `INSERT INTO task_outcomes (agent_group_id, session_id, message_id, series_id, kind, reason, status, recorded_at)
       VALUES (@agentGroupId, @sessionId, @messageId, @seriesId, @kind, @reason, @status, @recordedAt)`,
    {
      agentGroupId: outcome.agentGroupId,
      sessionId: outcome.sessionId,
      messageId: outcome.messageId,
      seriesId: outcome.seriesId ?? null,
      kind: outcome.kind ?? null,
      reason: outcome.reason,
      status: outcome.status ?? 'failed',
      recordedAt: new Date().toISOString(),
    },
  );
}

/** Most-recent-first outcomes for an agent group. Used by reflection/reporting. */
export async function listTaskOutcomes(agentGroupId: string, limit = 50): Promise<TaskOutcomeRow[]> {
  const db = getDb();
  if (!(await db.hasTable('task_outcomes'))) return [];
  return db.all<TaskOutcomeRow>(
    'SELECT * FROM task_outcomes WHERE agent_group_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?',
    agentGroupId,
    limit,
  );
}
