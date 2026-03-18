import { describe, it, expect } from 'vitest';

import type { Reaction } from './db.js';
import { formatMessages } from './router.js';
import type { NewMessage } from './types.js';

function msg(overrides: Partial<NewMessage> & { id: string }): NewMessage {
  return {
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('formatMessages', () => {
  it('formats messages without reactions (unchanged behavior)', () => {
    const result = formatMessages([msg({ id: 'm1', content: 'hello' })], 'UTC');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('hello</message>');
    expect(result).not.toContain('<reactions');
  });

  it('annotates messages with reactions when provided', () => {
    const reactions = new Map<string, Reaction[]>();
    reactions.set('m1', [
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: 'b@s.whatsapp.net',
        reactor_name: 'Bob',
        emoji: '👍',
        timestamp: '2024-01-01T00:00:10.000Z',
      },
    ]);

    const result = formatMessages(
      [msg({ id: 'm1', content: 'hello' })],
      'UTC',
      reactions,
    );
    expect(result).toContain('<reactions>');
    expect(result).toContain('👍 Bob');
    expect(result).toContain('</reactions>');
  });

  it('does not annotate messages without reactions', () => {
    const reactions = new Map<string, Reaction[]>();
    reactions.set('m1', [
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: 'b@s.whatsapp.net',
        reactor_name: 'Bob',
        emoji: '👍',
        timestamp: '2024-01-01T00:00:10.000Z',
      },
    ]);

    const result = formatMessages(
      [
        msg({ id: 'm1', content: 'hello' }),
        msg({ id: 'm2', content: 'no reactions here' }),
      ],
      'UTC',
      reactions,
    );

    // m1 should have reactions
    expect(result).toContain('👍 Bob');
    // m2 line should NOT have reactions tag
    const lines = result.split('\n');
    const m2Line = lines.find((l) => l.includes('no reactions here'));
    expect(m2Line).not.toContain('<reactions');
  });

  it('groups multiple same-emoji reactions compactly', () => {
    const reactions = new Map<string, Reaction[]>();
    reactions.set('m1', [
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: 'a@s.whatsapp.net',
        reactor_name: 'Alice',
        emoji: '👍',
        timestamp: '2024-01-01T00:00:10.000Z',
      },
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: 'b@s.whatsapp.net',
        reactor_name: 'Bob',
        emoji: '👍',
        timestamp: '2024-01-01T00:00:11.000Z',
      },
    ]);

    const result = formatMessages(
      [msg({ id: 'm1', content: 'great idea' })],
      'UTC',
      reactions,
    );
    // Should show grouped format like "👍 Alice, Bob"
    expect(result).toContain('👍 Alice, Bob');
  });

  it('shows different emojis separately', () => {
    const reactions = new Map<string, Reaction[]>();
    reactions.set('m1', [
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: 'a@s.whatsapp.net',
        reactor_name: 'Alice',
        emoji: '👍',
        timestamp: '2024-01-01T00:00:10.000Z',
      },
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: 'b@s.whatsapp.net',
        reactor_name: 'Bob',
        emoji: '❤️',
        timestamp: '2024-01-01T00:00:11.000Z',
      },
    ]);

    const result = formatMessages(
      [msg({ id: 'm1', content: 'mixed' })],
      'UTC',
      reactions,
    );
    expect(result).toContain('👍 Alice');
    expect(result).toContain('❤️ Bob');
  });

  it('handles empty reactions map gracefully', () => {
    const reactions = new Map<string, Reaction[]>();
    const result = formatMessages(
      [msg({ id: 'm1', content: 'hello' })],
      'UTC',
      reactions,
    );
    expect(result).not.toContain('<reactions');
  });

  it('uses reactor_jid prefix when reactor_name is missing', () => {
    const reactions = new Map<string, Reaction[]>();
    reactions.set('m1', [
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: '5551234@s.whatsapp.net',
        emoji: '👍',
        timestamp: '2024-01-01T00:00:10.000Z',
      },
    ]);

    const result = formatMessages(
      [msg({ id: 'm1', content: 'hello' })],
      'UTC',
      reactions,
    );
    expect(result).toContain('👍 5551234');
  });

  it('escapes XML in reactor names', () => {
    const reactions = new Map<string, Reaction[]>();
    reactions.set('m1', [
      {
        message_id: 'm1',
        message_chat_jid: 'group@g.us',
        reactor_jid: 'x@s.whatsapp.net',
        reactor_name: 'O"Brien & <Co>',
        emoji: '👍',
        timestamp: '2024-01-01T00:00:10.000Z',
      },
    ]);

    const result = formatMessages(
      [msg({ id: 'm1', content: 'hello' })],
      'UTC',
      reactions,
    );
    expect(result).toContain('&amp;');
    expect(result).toContain('&lt;');
    expect(result).not.toContain('O"Brien & <Co>');
  });
});
