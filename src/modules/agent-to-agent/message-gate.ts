/**
 * Approve handler for a held a2a message: reconstruct it from the payload and
 * re-route via `performAgentRoute`. `session` is the source session. Reject is
 * handled by the generic response-handler path (no handler needed here).
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
