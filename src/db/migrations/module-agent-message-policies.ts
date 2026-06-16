import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Agent message policies: an optional, directed, per-message approval gate on
 * top of an existing agent-to-agent connection.
 *
 * A row gates messages FROM `from_agent_group_id` TO `to_agent_group_id`: while
 * the connection (an `agent_destinations` edge) still allows the send, each
 * message is held for human approval before delivery. **No row = free flow**
 * (today's behavior) — the table is purely additive and backward compatible.
 *
 * The mere existence of a row means "require approval"; there is no `mode`
 * column in v1. A future mode (e.g. trust-on-first-use) would add the column
 * via its own migration.
 *
 * `approvers`: JSON array of user-ids permitted to approve. NULL = default to
 * the target group's admins/owners (via `pickApprover(to_agent_group_id)`).
 *
 * Directional + per-pair: the PK enforces one policy per (from → to). Gate both
 * directions with two rows. Policies are deleted alongside their connection
 * (see `deletePoliciesTouching`) so a stale rule can't silently reactivate on
 * re-wire.
 */
export const moduleAgentMessagePolicies: Migration = {
  version: 17,
  name: 'agent-message-policies',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_message_policies (
        from_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        to_agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
        approvers           TEXT,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (from_agent_group_id, to_agent_group_id)
      );
    `);
  },
};
