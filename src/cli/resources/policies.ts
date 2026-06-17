import { getAgentGroup } from '../../db/agent-groups.js';
import { hasAdminPrivilege } from '../../modules/permissions/db/user-roles.js';
import { removeMessagePolicy, setMessagePolicy } from '../../modules/agent-to-agent/db/agent-message-policies.js';
import { registerResource } from '../crud.js';

/** Parse `--approvers` (comma-separated user-ids) into a list, or null when omitted. */
function parseApprovers(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

registerResource({
  name: 'policy',
  plural: 'policies',
  table: 'agent_message_policies',
  description:
    'Agent-to-agent approval policy. A row requires every message from one agent to another to be approved by a human before delivery — without un-wiring the connection. No row = free flow. Directed and per-pair: gate both directions with two policies. Operator-only (agents cannot manage their own gates).',
  idColumn: 'from_agent_group_id',
  columns: [
    { name: 'from_agent_group_id', type: 'string', description: 'Source agent group. References agent_groups.id.' },
    { name: 'to_agent_group_id', type: 'string', description: 'Target agent group. References agent_groups.id.' },
    {
      name: 'approvers',
      type: 'string',
      description: 'JSON array of user-ids allowed to approve. Empty/NULL = the target group’s admins/owners.',
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    set: {
      access: 'approval',
      description:
        'Require approval for messages from one agent to another. Use --from <agent-group-id> --to <agent-group-id> [--approvers <user-id,user-id>]. Named approvers must be admins/owners of the target.',
      handler: async (args) => {
        const from = args.from as string;
        const to = args.to as string;
        if (!from) throw new Error('--from is required');
        if (!to) throw new Error('--to is required');
        if (from === to) throw new Error('--from and --to must differ (self-messages are never gated)');
        if (!getAgentGroup(from)) throw new Error(`source agent group not found: ${from}`);
        if (!getAgentGroup(to)) throw new Error(`target agent group not found: ${to}`);

        const approvers = parseApprovers(args.approvers);
        if (approvers) {
          for (const userId of approvers) {
            if (!hasAdminPrivilege(userId, to)) {
              throw new Error(`approver "${userId}" is not an admin/owner of the target agent group`);
            }
          }
        }

        setMessagePolicy(from, to, approvers ? JSON.stringify(approvers) : null, new Date().toISOString());
        return { from_agent_group_id: from, to_agent_group_id: to, approvers: approvers ?? null };
      },
    },
    remove: {
      access: 'approval',
      description: 'Remove an approval policy (back to free flow). Use --from <agent-group-id> --to <agent-group-id>.',
      handler: async (args) => {
        const from = args.from as string;
        const to = args.to as string;
        if (!from) throw new Error('--from is required');
        if (!to) throw new Error('--to is required');
        if (!removeMessagePolicy(from, to)) throw new Error('policy not found');
        return { removed: { from_agent_group_id: from, to_agent_group_id: to } };
      },
    },
  },
});
