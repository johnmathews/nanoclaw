import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-group memory budgets (learning & memory layer, feature #1). The
 * `remember` tool curates two budgeted files injected into CLAUDE.md:
 * `MEMORY.md` (operational lessons) and `USER.md` (user profile). The budget
 * is a hard character cap the tool enforces — at capacity it errors and hands
 * back the current entries, forcing the agent to consolidate before adding.
 *
 * Defaults are the Hermes-proven 2200 / 1375 chars. New groups inherit these
 * via the column DEFAULT (ensureContainerConfig uses INSERT OR IGNORE);
 * existing groups are seeded to fit their migrated CLAUDE.local.md content at
 * first compose (src/claude-md-compose.ts). Editable anytime via
 * `ncl groups config update --memory-budget / --user-budget`.
 */
export const migration021: Migration = {
  version: 21,
  name: 'memory-budgets',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN memory_budget_chars INTEGER NOT NULL DEFAULT 2200;`);
    db.exec(`ALTER TABLE container_configs ADD COLUMN user_budget_chars INTEGER NOT NULL DEFAULT 1375;`);
  },
};
