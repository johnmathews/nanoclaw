import type { Migration } from './index.js';

/**
 * Per-channel reply placement on `messaging_groups`.
 *
 * 'thread' = reply in the inbound message's thread; 'channel' = strip the
 * inbound thread_id at delivery so replies land in the channel root (see
 * deliverMessage in src/delivery.ts). Added as a column default of 'thread'
 * here; migration 027 flips existing rows to this install's standing
 * preference.
 *
 * NAME IS LOAD-BEARING: 'reply-mode' is already recorded in this install's
 * schema_version ledger (applied under the fork's old numbering), so the
 * runner skips it here and still applies it on a fresh install. Renaming it
 * makes the live DB re-run the ALTER against an existing column, which fails.
 * See .nanoclaw-migrations/index.md §1.11.
 */
export const migration026: Migration = {
  version: 26,
  name: 'reply-mode',
  async up(db) {
    await db.exec(`ALTER TABLE messaging_groups ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'thread';`);
  },
};
