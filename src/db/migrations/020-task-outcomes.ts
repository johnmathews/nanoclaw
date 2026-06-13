import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Task outcome log (learning & memory layer, feature #3). When a message
 * exhausts its retries in the host sweep (`resetStuckProcessingRows` in
 * src/host-sweep.ts), the host marks it `failed` but historically threw the
 * failure *reason* away — it only reached `log.warn`. This table persists the
 * reason + context so the agent's reflection pass (and operators) can see what
 * went wrong over time instead of a bare `status='failed'`.
 *
 * Central DB (not a session DB): admin-visible, survives restarts, and queried
 * across sessions. `kind` distinguishes scheduled-task failures from chat ones;
 * `series_id` ties recurring-task failures together. No FK to messages_in —
 * that row lives in a per-session DB, not here.
 */
export const migration020: Migration = {
  version: 20,
  name: 'task-outcomes',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_group_id  TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        series_id       TEXT,
        kind            TEXT,
        reason          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'failed',
        recorded_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_outcomes_group ON task_outcomes(agent_group_id);
    `);
  },
};
