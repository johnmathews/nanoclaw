/**
 * Per-message approval policies for agent-to-agent connections. A row gates
 * from→to; no row (undefined) = free flow. Operator-managed via `ncl policies`.
 */
import type { AgentMessagePolicy } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

/** Returns the policy gating `from → to`, or undefined when the connection is free. */
export function getMessagePolicy(fromAgentGroupId: string, toAgentGroupId: string): AgentMessagePolicy | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?')
    .get(fromAgentGroupId, toAgentGroupId) as AgentMessagePolicy | undefined;
}

/** Upsert a policy for `from → to`. `approvers` is a JSON array string, or null. */
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

/** Delete every policy touching this agent group, so none outlives its connection. */
export function deletePoliciesTouching(agentGroupId: string): void {
  getDb()
    .prepare('DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?')
    .run(agentGroupId, agentGroupId);
}
