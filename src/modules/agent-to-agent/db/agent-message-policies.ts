/**
 * Per-message approval policies for agent-to-agent connections.
 *
 * A row gates messages FROM `from_agent_group_id` TO `to_agent_group_id`: each
 * such message is held for human approval before delivery. **No row = free
 * flow** — `getMessagePolicy` returning undefined means "deliver as today".
 *
 * Directed and per-pair (PK on from+to). Policies are operator-managed via
 * `ncl policies` and deleted alongside their connection via
 * `deletePoliciesTouching` (called from the destination-delete paths) so a
 * stale rule can't silently reactivate when a connection is re-wired.
 */
import type { AgentMessagePolicy } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

/** Returns the policy gating `from → to`, or undefined when the connection is free. */
export function getMessagePolicy(fromAgentGroupId: string, toAgentGroupId: string): AgentMessagePolicy | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?')
    .get(fromAgentGroupId, toAgentGroupId) as AgentMessagePolicy | undefined;
}

/**
 * Upsert a require-approval policy for `from → to`. `approvers` is a JSON array
 * string of user-ids (or null to default to the target's admins/owners).
 */
export function setMessagePolicy(
  fromAgentGroupId: string,
  toAgentGroupId: string,
  approvers: string | null,
  createdAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_message_policies (from_agent_group_id, to_agent_group_id, approvers, created_at)
       VALUES (@from_agent_group_id, @to_agent_group_id, @approvers, @created_at)
       ON CONFLICT (from_agent_group_id, to_agent_group_id)
       DO UPDATE SET approvers = excluded.approvers`,
    )
    .run({
      from_agent_group_id: fromAgentGroupId,
      to_agent_group_id: toAgentGroupId,
      approvers,
      created_at: createdAt,
    });
}

/** Remove the policy for `from → to`. Returns true if a row was deleted. */
export function removeMessagePolicy(fromAgentGroupId: string, toAgentGroupId: string): boolean {
  const info = getDb()
    .prepare('DELETE FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?')
    .run(fromAgentGroupId, toAgentGroupId);
  return info.changes > 0;
}

/**
 * Delete every policy where this agent group is either side of the edge. Called
 * from the destination-delete paths so a policy never outlives its connection
 * (which would re-gate silently on re-wire).
 */
export function deletePoliciesTouching(agentGroupId: string): void {
  getDb()
    .prepare('DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?')
    .run(agentGroupId, agentGroupId);
}
