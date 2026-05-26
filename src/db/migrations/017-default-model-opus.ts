import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Backfill any container_configs rows with `model IS NULL` to the new
 * default (claude-opus-4-7). Pre-migration, NULL meant "use SDK default"
 * which silently routed to a Sonnet variant — we want Opus 4.7 everywhere
 * unless an operator explicitly overrides.
 */
export const migration017: Migration = {
  version: 17,
  name: 'default-model-opus',
  up(db: Database.Database) {
    db.prepare("UPDATE container_configs SET model = 'claude-opus-4-7' WHERE model IS NULL OR model = ''").run();
  },
};
