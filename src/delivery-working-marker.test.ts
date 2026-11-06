/**
 * Fork: which delivered rows clear the Slack 👀 working marker. A reply does;
 * an agent's own reaction or edit (operations on earlier messages), system
 * rows, and task-run logs do not.
 */
import { describe, expect, it } from 'vitest';

import { isUserVisibleReply } from './delivery.js';

describe('isUserVisibleReply', () => {
  it('a chat reply clears the marker', () => {
    expect(isUserVisibleReply('chat', JSON.stringify({ text: 'Here you go' }))).toBe(true);
    expect(isUserVisibleReply('chat-sdk', JSON.stringify({ type: 'blocks', blocks: [] }))).toBe(true);
  });

  it('an agent reaction or edit does not', () => {
    expect(isUserVisibleReply('chat', JSON.stringify({ operation: 'reaction', messageId: '1.1', emoji: 'eyes' }))).toBe(
      false,
    );
    expect(isUserVisibleReply('chat', JSON.stringify({ operation: 'edit', messageId: '1.1', text: 'x' }))).toBe(false);
  });

  it('system rows and task logs do not', () => {
    expect(isUserVisibleReply('system', JSON.stringify({ text: 'x' }))).toBe(false);
    expect(isUserVisibleReply('task_log', JSON.stringify({ text: 'x' }))).toBe(false);
  });

  it('unparseable content counts as a reply (fail towards clearing)', () => {
    expect(isUserVisibleReply('chat', 'not json')).toBe(true);
  });
});
