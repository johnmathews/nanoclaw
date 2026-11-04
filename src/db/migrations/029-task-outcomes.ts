import type { Migration } from './index.js';

/**
 * Task outcome log. When a message exhausts its retries in the host sweep the
 * host marks it failed but historically threw the *reason* away — it only
 * reached log.warn. This table persists the reason plus context so operators
 * (and a reflection pass) can see what went wrong over time instead of a bare
 * status='failed'.
 *
 * Distinct from upstream's task-series run log
 * (src/modules/scheduling/run-log.ts), which appends a human-readable
 * narrative to groups/<folder>/tasks/<series>.md written by the agent and by a
 * task run's final text. This table records host-detected failures the agent
 * cannot log itself, machine-readably.
 *
 * Central DB, not a session DB: admin-visible, survives restarts, queried
 * across sessions. `kind` separates scheduled-task failures from chat ones;
 * `series_id` ties recurring-task failures together. No FK to messages_in —
 * that row lives in a per-session DB.
 *
 * NAME IS LOAD-BEARING — see migration 026's header.
 */
export const migration029: Migration = {
  version: 29,
  name: 'task-outcomes',
  async up(db) {
    await db.exec(`
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
