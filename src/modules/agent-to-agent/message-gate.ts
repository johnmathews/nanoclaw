/**
 * Approval handler for held agent-to-agent messages (`a2a_message_gate`).
 *
 * When a directed require-approval policy gates an A→B send, `routeAgentMessage`
 * holds the message in the approval payload and queues a card to B's admins.
 * On approve, this handler reconstructs the original message and re-routes it
 * via `performAgentRoute` — the same path a free (ungated) send takes.
 *
 * Reject needs no handler here: the generic reject path in the approvals
 * response handler already notifies the source agent and drops the row.
 *
 * `session` is the SOURCE (requesting) session — `performAgentRoute` needs it
 * for `agent_group_id` / `id` (return-path stamping), exactly as the live path.
 */
import { log } from '../../log.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { performAgentRoute, type RoutableAgentMessage } from './agent-route.js';

export const applyA2aMessageGate: ApprovalHandler = async ({ session, payload, notify }) => {
  const targetAgentGroupId = typeof payload.platform_id === 'string' ? payload.platform_id : '';
  if (!targetAgentGroupId) {
    notify('Message approved but the target agent group was missing from the request.');
    log.warn('a2a_message_gate apply: missing target', { sessionId: session.id });
    return;
  }

  const msg: RoutableAgentMessage = {
    id: typeof payload.id === 'string' ? payload.id : `a2a-gate-${Date.now()}`,
    platform_id: targetAgentGroupId,
    content: typeof payload.content === 'string' ? payload.content : '',
    in_reply_to: typeof payload.in_reply_to === 'string' ? payload.in_reply_to : null,
  };

  await performAgentRoute(msg, session, targetAgentGroupId);
  log.info('Held agent message delivered after approval', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    msgId: msg.id,
  });
};
