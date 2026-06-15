import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'reply-mode',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE messaging_groups ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'thread'").run();
  },
};
