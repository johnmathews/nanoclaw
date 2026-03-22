/**
 * Pure logic functions extracted from the message loop for testability.
 * These are stateless helpers that can be tested without mocking the world.
 */
import type { NewMessage } from './types.js';

/**
 * Group messages by their chat_jid (deduplication).
 * Returns a Map of chatJid → messages.
 */
export function groupMessagesByJid(
  messages: NewMessage[],
): Map<string, NewMessage[]> {
  const messagesByGroup = new Map<string, NewMessage[]>();
  for (const msg of messages) {
    const existing = messagesByGroup.get(msg.chat_jid);
    if (existing) {
      existing.push(msg);
    } else {
      messagesByGroup.set(msg.chat_jid, [msg]);
    }
  }
  return messagesByGroup;
}

/**
 * Compute the safe cursor position — the max timestamp of messages
 * whose channels are connected. Messages for disconnected channels
 * are excluded so they stay behind the cursor for retry.
 */
export function computeSafeCursor(
  messagesByGroup: Map<string, NewMessage[]>,
  hasChannel: (jid: string) => boolean,
  currentCursor: string,
): string {
  let maxTimestamp = currentCursor;
  for (const [chatJid, messages] of messagesByGroup) {
    if (!hasChannel(chatJid)) continue;
    const groupMax = messages[messages.length - 1]?.timestamp || '';
    if (groupMax > maxTimestamp) {
      maxTimestamp = groupMax;
    }
  }
  return maxTimestamp;
}

/**
 * Determine whether a non-main group should be skipped because
 * none of its messages contain a trigger.
 */
export function shouldSkipForTrigger(
  messages: NewMessage[],
  triggerPattern: RegExp,
  isTriggerAllowedFn: (sender: string) => boolean,
): boolean {
  return !messages.some(
    (m) =>
      triggerPattern.test(m.content.trim()) &&
      (m.is_from_me || isTriggerAllowedFn(m.sender)),
  );
}
