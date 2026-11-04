import type { Migration } from './index.js';

/**
 * Flip the standing reply-mode preference to 'channel' for every existing
 * messaging group. Operator preference (2026-06-12): replies land in the
 * channel, not a thread. The create paths default to 'channel' in code
 * (createMessagingGroup, the ncl crud field), so this only fixes rows that
 * predate the change.
 *
 * NAME IS LOAD-BEARING — see migration 026's header.
 */
export const migration027: Migration = {
  version: 27,
  name: 'reply-mode-channel-default',
  async up(db) {
    await db.exec(`UPDATE messaging_groups SET reply_mode = 'channel' WHERE reply_mode != 'channel';`);
  },
};
