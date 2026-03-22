import { describe, it, expect } from 'vitest';

import {
  groupMessagesByJid,
  computeSafeCursor,
  shouldSkipForTrigger,
} from './message-loop.js';
import type { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg1',
    chat_jid: 'group1@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content: 'Hello',
    timestamp: '2026-03-22T10:00:00Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

describe('groupMessagesByJid', () => {
  it('returns empty map for empty input', () => {
    const result = groupMessagesByJid([]);
    expect(result.size).toBe(0);
  });

  it('groups messages by chat_jid', () => {
    const msgs = [
      makeMsg({ id: 'm1', chat_jid: 'a@g.us' }),
      makeMsg({ id: 'm2', chat_jid: 'b@g.us' }),
      makeMsg({ id: 'm3', chat_jid: 'a@g.us' }),
    ];
    const result = groupMessagesByJid(msgs);
    expect(result.size).toBe(2);
    expect(result.get('a@g.us')).toHaveLength(2);
    expect(result.get('b@g.us')).toHaveLength(1);
  });

  it('preserves message order within each group', () => {
    const msgs = [
      makeMsg({
        id: 'm1',
        chat_jid: 'a@g.us',
        timestamp: '2026-03-22T10:00:00Z',
      }),
      makeMsg({
        id: 'm2',
        chat_jid: 'a@g.us',
        timestamp: '2026-03-22T10:01:00Z',
      }),
    ];
    const result = groupMessagesByJid(msgs);
    const group = result.get('a@g.us')!;
    expect(group[0].id).toBe('m1');
    expect(group[1].id).toBe('m2');
  });

  it('handles single message', () => {
    const msgs = [makeMsg({ id: 'm1', chat_jid: 'a@g.us' })];
    const result = groupMessagesByJid(msgs);
    expect(result.size).toBe(1);
    expect(result.get('a@g.us')).toHaveLength(1);
  });
});

describe('computeSafeCursor', () => {
  it('advances to max timestamp of connected channels', () => {
    const groups = new Map<string, NewMessage[]>();
    groups.set('a@g.us', [
      makeMsg({ timestamp: '2026-03-22T10:01:00Z', chat_jid: 'a@g.us' }),
    ]);
    groups.set('b@g.us', [
      makeMsg({ timestamp: '2026-03-22T10:02:00Z', chat_jid: 'b@g.us' }),
    ]);

    const result = computeSafeCursor(groups, () => true, '');
    expect(result).toBe('2026-03-22T10:02:00Z');
  });

  it('skips messages for disconnected channels', () => {
    const groups = new Map<string, NewMessage[]>();
    groups.set('connected@g.us', [
      makeMsg({
        timestamp: '2026-03-22T10:01:00Z',
        chat_jid: 'connected@g.us',
      }),
    ]);
    groups.set('disconnected@g.us', [
      makeMsg({
        timestamp: '2026-03-22T10:05:00Z',
        chat_jid: 'disconnected@g.us',
      }),
    ]);

    const hasChannel = (jid: string) => jid === 'connected@g.us';
    const result = computeSafeCursor(groups, hasChannel, '');
    expect(result).toBe('2026-03-22T10:01:00Z');
  });

  it('returns current cursor when all channels disconnected', () => {
    const groups = new Map<string, NewMessage[]>();
    groups.set('a@g.us', [
      makeMsg({ timestamp: '2026-03-22T10:01:00Z', chat_jid: 'a@g.us' }),
    ]);

    const result = computeSafeCursor(
      groups,
      () => false,
      '2026-03-22T09:00:00Z',
    );
    expect(result).toBe('2026-03-22T09:00:00Z');
  });

  it('returns current cursor for empty message map', () => {
    const groups = new Map<string, NewMessage[]>();
    const result = computeSafeCursor(
      groups,
      () => true,
      '2026-03-22T09:00:00Z',
    );
    expect(result).toBe('2026-03-22T09:00:00Z');
  });

  it('does not go backwards from current cursor', () => {
    const groups = new Map<string, NewMessage[]>();
    groups.set('a@g.us', [
      makeMsg({ timestamp: '2026-03-22T08:00:00Z', chat_jid: 'a@g.us' }),
    ]);

    const result = computeSafeCursor(
      groups,
      () => true,
      '2026-03-22T09:00:00Z',
    );
    expect(result).toBe('2026-03-22T09:00:00Z');
  });
});

describe('shouldSkipForTrigger', () => {
  const triggerPattern = /^@agent\b/i;

  it('returns false when a message matches the trigger and is from_me', () => {
    const msgs = [makeMsg({ content: '@agent hello', is_from_me: true })];
    const result = shouldSkipForTrigger(msgs, triggerPattern, () => false);
    expect(result).toBe(false);
  });

  it('returns false when trigger is present and sender is allowed', () => {
    const msgs = [makeMsg({ content: '@agent hello', is_from_me: false })];
    const result = shouldSkipForTrigger(msgs, triggerPattern, () => true);
    expect(result).toBe(false);
  });

  it('returns true when trigger is present but sender is not allowed', () => {
    const msgs = [makeMsg({ content: '@agent hello', is_from_me: false })];
    const result = shouldSkipForTrigger(msgs, triggerPattern, () => false);
    expect(result).toBe(true);
  });

  it('returns true when no messages match the trigger', () => {
    const msgs = [
      makeMsg({ content: 'just a normal message' }),
      makeMsg({ content: 'another one' }),
    ];
    const result = shouldSkipForTrigger(msgs, triggerPattern, () => true);
    expect(result).toBe(true);
  });

  it('returns false when trigger is in one of multiple messages', () => {
    const msgs = [
      makeMsg({ content: 'no trigger here' }),
      makeMsg({ content: '@agent do something', is_from_me: true }),
    ];
    const result = shouldSkipForTrigger(msgs, triggerPattern, () => false);
    expect(result).toBe(false);
  });

  it('returns true for empty message array', () => {
    const result = shouldSkipForTrigger([], triggerPattern, () => true);
    expect(result).toBe(true);
  });

  it('handles trigger with leading whitespace', () => {
    const msgs = [makeMsg({ content: '  @agent hello', is_from_me: true })];
    const result = shouldSkipForTrigger(msgs, triggerPattern, () => false);
    expect(result).toBe(false);
  });
});
