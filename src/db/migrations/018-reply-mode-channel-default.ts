import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Flip the standing reply-mode preference to 'channel' for every existing
 * messaging group. Operator preference (2026-06-12): replies should land in
 * the channel, not a thread. The column default and create paths are updated
 * to 'channel' in code (schema.ts, createMessagingGroup, the ncl crud field),
 * so this only needs to fix rows that predate the change.
 */
export const migration018: Migration = {
  version: 18,
  name: 'reply-mode-channel-default',
  up(db: Database.Database) {
    db.prepare("UPDATE messaging_groups SET reply_mode = 'channel' WHERE reply_mode != 'channel'").run();
  },
};
