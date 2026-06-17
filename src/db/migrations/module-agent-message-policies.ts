import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Per-message approval gate on an agent-to-agent connection. A row gates
 * messages from→to (PK enforces one per direction); no row = free flow.
 * `approver`: a specific admin/owner of the target who approves, or NULL to
 * default to all the target's admins/owners.
 */
export const moduleAgentMessagePolicies: Migration = {
  version: 17,
  name: 'agent-message-policies',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_message_policies (
        from_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        to_agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
        approver            TEXT,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (from_agent_group_id, to_agent_group_id)
      );
    `);
  },
};
