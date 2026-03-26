import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteSession,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getLatestMessage,
  getMessageContent,
  getMessageFromMe,
  getMessagesByReaction,
  getMessagesSince,
  getNewMessages,
  getSession,
  getReactionsForChat,
  getReactionsForMessage,
  getReactionsForMessages,
  getReactionsByUser,
  getReactionStats,
  getRegisteredGroup,
  getTaskById,
  getRateLimits,
  getSchemaVersion,
  getSchemaVersionHistory,
  upsertRateLimit,
  setRegisteredGroup,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeReaction,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- getLatestMessage ---

describe('getLatestMessage', () => {
  it('returns the most recent message for a chat', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'old',
      chat_jid: 'group@g.us',
      sender: 'a@s.whatsapp.net',
      sender_name: 'A',
      content: 'old',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'new',
      chat_jid: 'group@g.us',
      sender: 'b@s.whatsapp.net',
      sender_name: 'B',
      content: 'new',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const latest = getLatestMessage('group@g.us');
    expect(latest).toEqual({ id: 'new', fromMe: false });
  });

  it('returns fromMe: true for own messages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'mine',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
    });

    const latest = getLatestMessage('group@g.us');
    expect(latest).toEqual({ id: 'mine', fromMe: true });
  });

  it('returns undefined for empty chat', () => {
    expect(getLatestMessage('nonexistent@g.us')).toBeUndefined();
  });
});

// --- getMessageFromMe ---

describe('getMessageFromMe', () => {
  it('returns true for own messages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'mine',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
    });

    expect(getMessageFromMe('mine', 'group@g.us')).toBe(true);
  });

  it('returns false for other messages', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'theirs',
      chat_jid: 'group@g.us',
      sender: 'a@s.whatsapp.net',
      sender_name: 'A',
      content: 'their msg',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    expect(getMessageFromMe('theirs', 'group@g.us')).toBe(false);
  });

  it('returns false for nonexistent message', () => {
    expect(getMessageFromMe('nonexistent', 'group@g.us')).toBe(false);
  });
});

// --- storeReaction ---

describe('storeReaction', () => {
  it('stores and retrieves a reaction', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'user@s.whatsapp.net',
      reactor_name: 'Alice',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const reactions = getReactionsForMessage('msg-1', 'group@g.us');
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('👍');
    expect(reactions[0].reactor_name).toBe('Alice');
  });

  it('upserts on same reactor + message', () => {
    const base = {
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'user@s.whatsapp.net',
      reactor_name: 'Alice',
      timestamp: '2024-01-01T00:00:01.000Z',
    };
    storeReaction({ ...base, emoji: '👍' });
    storeReaction({
      ...base,
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const reactions = getReactionsForMessage('msg-1', 'group@g.us');
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('❤️');
  });

  it('removes reaction when emoji is empty', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'user@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'user@s.whatsapp.net',
      emoji: '',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    expect(getReactionsForMessage('msg-1', 'group@g.us')).toHaveLength(0);
  });
});

// --- getReactionsForMessage ---

describe('getReactionsForMessage', () => {
  it('returns multiple reactions ordered by timestamp', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'a@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const reactions = getReactionsForMessage('msg-1', 'group@g.us');
    expect(reactions).toHaveLength(2);
    expect(reactions[0].reactor_jid).toBe('a@s.whatsapp.net');
    expect(reactions[1].reactor_jid).toBe('b@s.whatsapp.net');
  });

  it('returns empty array for message with no reactions', () => {
    expect(getReactionsForMessage('nonexistent', 'group@g.us')).toEqual([]);
  });
});

// --- getMessagesByReaction ---

describe('getMessagesByReaction', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'author@s.whatsapp.net',
      sender_name: 'Author',
      content: 'bookmarked msg',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'user@s.whatsapp.net',
      emoji: '📌',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
  });

  it('joins reactions with messages', () => {
    const results = getMessagesByReaction('user@s.whatsapp.net', '📌');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('bookmarked msg');
    expect(results[0].sender_name).toBe('Author');
  });

  it('filters by chatJid when provided', () => {
    const results = getMessagesByReaction(
      'user@s.whatsapp.net',
      '📌',
      'group@g.us',
    );
    expect(results).toHaveLength(1);

    const empty = getMessagesByReaction(
      'user@s.whatsapp.net',
      '📌',
      'other@g.us',
    );
    expect(empty).toHaveLength(0);
  });

  it('returns empty when no matching reactions', () => {
    expect(getMessagesByReaction('user@s.whatsapp.net', '🔥')).toHaveLength(0);
  });
});

// --- getReactionsByUser ---

describe('getReactionsByUser', () => {
  it('returns reactions for a user ordered by timestamp desc', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'user@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-2',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'user@s.whatsapp.net',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const reactions = getReactionsByUser('user@s.whatsapp.net');
    expect(reactions).toHaveLength(2);
    expect(reactions[0].emoji).toBe('❤️'); // newer first
    expect(reactions[1].emoji).toBe('👍');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      storeReaction({
        message_id: `msg-${i}`,
        message_chat_jid: 'group@g.us',
        reactor_jid: 'user@s.whatsapp.net',
        emoji: '👍',
        timestamp: `2024-01-01T00:00:0${i}.000Z`,
      });
    }

    expect(getReactionsByUser('user@s.whatsapp.net', 3)).toHaveLength(3);
  });

  it('returns empty for user with no reactions', () => {
    expect(getReactionsByUser('nobody@s.whatsapp.net')).toEqual([]);
  });
});

// --- getReactionStats ---

describe('getReactionStats', () => {
  beforeEach(() => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'a@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-2',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'c@s.whatsapp.net',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'other@g.us',
      reactor_jid: 'a@s.whatsapp.net',
      emoji: '🔥',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns global stats ordered by count desc', () => {
    const stats = getReactionStats();
    expect(stats[0]).toEqual({ emoji: '👍', count: 2 });
    expect(stats).toHaveLength(3);
  });

  it('filters by chatJid', () => {
    const stats = getReactionStats('group@g.us');
    expect(stats).toHaveLength(2);
    expect(stats.find((s) => s.emoji === '🔥')).toBeUndefined();
  });

  it('returns empty for chat with no reactions', () => {
    expect(getReactionStats('empty@g.us')).toEqual([]);
  });
});

// --- getReactionsForMessages (Flow 3: batch query) ---

describe('getReactionsForMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'a@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: 'b@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'world',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'c@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'no reactions on this',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
  });

  it('returns reactions for multiple messages in one query', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      reactor_name: 'Bob',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:10.000Z',
    });
    storeReaction({
      message_id: 'msg-2',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'a@s.whatsapp.net',
      reactor_name: 'Alice',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:11.000Z',
    });

    const reactions = getReactionsForMessages(
      ['msg-1', 'msg-2', 'msg-3'],
      'group@g.us',
    );
    expect(reactions).toHaveLength(2);
    expect(reactions.find((r) => r.message_id === 'msg-1')?.emoji).toBe('👍');
    expect(reactions.find((r) => r.message_id === 'msg-2')?.emoji).toBe('❤️');
  });

  it('returns empty array for empty messageIds', () => {
    expect(getReactionsForMessages([], 'group@g.us')).toEqual([]);
  });

  it('returns empty array when no reactions exist', () => {
    expect(getReactionsForMessages(['msg-1', 'msg-2'], 'group@g.us')).toEqual(
      [],
    );
  });

  it('filters by chatJid', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:10.000Z',
    });

    // Same message_id but different chat — should not be returned
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'other@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      emoji: '🔥',
      timestamp: '2024-01-01T00:00:10.000Z',
    });

    const reactions = getReactionsForMessages(['msg-1'], 'group@g.us');
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('👍');
  });

  it('returns multiple reactions on the same message', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'a@s.whatsapp.net',
      reactor_name: 'Alice',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:10.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      reactor_name: 'Bob',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:11.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'c@s.whatsapp.net',
      reactor_name: 'Carol',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:12.000Z',
    });

    const reactions = getReactionsForMessages(['msg-1'], 'group@g.us');
    expect(reactions).toHaveLength(3);
  });
});

// --- getMessageContent (Flow 4: lookup for synthetic messages) ---

describe('getMessageContent', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
  });

  it('returns content for an existing message', () => {
    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'a@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    expect(getMessageContent('msg-1', 'group@g.us')).toBe('hello world');
  });

  it('returns undefined for nonexistent message', () => {
    expect(getMessageContent('nonexistent', 'group@g.us')).toBeUndefined();
  });

  it('returns content for correct chatJid only', () => {
    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'a@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    expect(getMessageContent('msg-1', 'other@g.us')).toBeUndefined();
  });
});

// --- getReactionsForChat (Flow 5: snapshot data) ---

describe('getReactionsForChat', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'a@s.whatsapp.net',
      sender_name: 'Alice',
      content:
        'hello world, this is a long message that should be truncated in the preview',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: 'b@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'short msg',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
  });

  it('returns reactions joined with message context', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      reactor_name: 'Bob',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:10.000Z',
    });

    const results = getReactionsForChat('group@g.us');
    expect(results).toHaveLength(1);
    expect(results[0].emoji).toBe('👍');
    expect(results[0].reactor_name).toBe('Bob');
    expect(results[0].message_sender).toBe('Alice');
    expect(results[0].message_preview).toBeDefined();
    expect(results[0].message_id).toBe('msg-1');
  });

  it('respects limit parameter', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:10.000Z',
    });
    storeReaction({
      message_id: 'msg-2',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'a@s.whatsapp.net',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:11.000Z',
    });

    expect(getReactionsForChat('group@g.us', 1)).toHaveLength(1);
  });

  it('returns newest reactions first', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:10.000Z',
    });
    storeReaction({
      message_id: 'msg-2',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'a@s.whatsapp.net',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:11.000Z',
    });

    const results = getReactionsForChat('group@g.us');
    expect(results[0].emoji).toBe('❤️'); // newer first
    expect(results[1].emoji).toBe('👍');
  });

  it('returns empty for chat with no reactions', () => {
    expect(getReactionsForChat('group@g.us')).toEqual([]);
  });

  it('filters by chatJid', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'group@g.us',
      reactor_jid: 'b@s.whatsapp.net',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:10.000Z',
    });

    expect(getReactionsForChat('other@g.us')).toEqual([]);
  });
});

// --- Registered groups ---

describe('registered groups', () => {
  const mainGroup = {
    name: 'Main',
    folder: 'main',
    trigger: '@Bot',
    added_at: '2024-01-01',
    isMain: true,
  };

  const otherGroup = {
    name: 'Other',
    folder: 'slack_other',
    trigger: '@Bot',
    added_at: '2024-01-02',
  };

  it('round-trips isMain through setRegisteredGroup/getRegisteredGroup', () => {
    setRegisteredGroup('jid-main', mainGroup);
    const loaded = getRegisteredGroup('jid-main');
    expect(loaded?.isMain).toBe(true);
  });

  it('returns isMain as falsy for non-main groups', () => {
    setRegisteredGroup('jid-other', otherGroup);
    const loaded = getRegisteredGroup('jid-other');
    expect(loaded?.isMain).toBeFalsy();
  });

  it('populates isMain in getAllRegisteredGroups', () => {
    setRegisteredGroup('jid-main', mainGroup);
    setRegisteredGroup('jid-other', otherGroup);
    const all = getAllRegisteredGroups();
    expect(all['jid-main'].isMain).toBe(true);
    expect(all['jid-other'].isMain).toBeFalsy();
  });

  it('preserves isMain on re-registration', () => {
    setRegisteredGroup('jid-main', mainGroup);
    setRegisteredGroup('jid-main', { ...mainGroup, name: 'Renamed' });
    const loaded = getRegisteredGroup('jid-main');
    expect(loaded?.isMain).toBe(true);
    expect(loaded?.name).toBe('Renamed');
  });

  it('round-trips requiresTrigger', () => {
    setRegisteredGroup('jid-a', { ...otherGroup, requiresTrigger: false });
    setRegisteredGroup('jid-b', {
      ...otherGroup,
      folder: 'slack_b',
      requiresTrigger: true,
    });
    expect(getRegisteredGroup('jid-a')?.requiresTrigger).toBe(false);
    expect(getRegisteredGroup('jid-b')?.requiresTrigger).toBe(true);
  });

  it('round-trips containerConfig', () => {
    const config = {
      additionalMounts: [
        { hostPath: '/data', containerPath: 'data', readonly: true },
      ],
    };
    setRegisteredGroup('jid-cfg', {
      ...otherGroup,
      folder: 'slack_cfg',
      containerConfig: config,
    });
    const loaded = getRegisteredGroup('jid-cfg');
    expect(loaded?.containerConfig).toEqual(config);
  });

  it('returns undefined containerConfig when not set', () => {
    setRegisteredGroup('jid-other', otherGroup);
    expect(getRegisteredGroup('jid-other')?.containerConfig).toBeUndefined();
  });

  it('round-trips all fields through getAllRegisteredGroups', () => {
    const full = {
      name: 'Full',
      folder: 'slack_full',
      trigger: '@Bot',
      added_at: '2024-01-03',
      isMain: true,
      requiresTrigger: false,
      containerConfig: {
        additionalMounts: [
          { hostPath: '/x', containerPath: 'x', readonly: true },
        ],
      },
    };
    setRegisteredGroup('jid-full', full);
    const all = getAllRegisteredGroups();
    const loaded = all['jid-full'];
    expect(loaded.name).toBe('Full');
    expect(loaded.folder).toBe('slack_full');
    expect(loaded.trigger).toBe('@Bot');
    expect(loaded.added_at).toBe('2024-01-03');
    expect(loaded.isMain).toBe(true);
    expect(loaded.requiresTrigger).toBe(false);
    expect(loaded.containerConfig).toEqual({
      additionalMounts: [
        { hostPath: '/x', containerPath: 'x', readonly: true },
      ],
    });
  });
});

describe('rate_limits', () => {
  it('round-trips upsertRateLimit / getRateLimits', () => {
    upsertRateLimit({
      status: 'allowed',
      rate_limit_type: 'five_hour',
      utilization: 0.18,
      resets_at: 1711929600000,
    });
    const rows = getRateLimits();
    expect(rows).toHaveLength(1);
    expect(rows[0].rate_limit_type).toBe('five_hour');
    expect(rows[0].status).toBe('allowed');
    expect(rows[0].utilization).toBe(0.18);
    expect(rows[0].resets_at).toBe(1711929600000);
  });

  it('upserts on same rate_limit_type', () => {
    upsertRateLimit({
      status: 'allowed',
      rate_limit_type: 'five_hour',
      utilization: 0.1,
    });
    upsertRateLimit({
      status: 'allowed_warning',
      rate_limit_type: 'five_hour',
      utilization: 0.85,
    });
    const rows = getRateLimits();
    expect(rows).toHaveLength(1);
    expect(rows[0].utilization).toBe(0.85);
    expect(rows[0].status).toBe('allowed_warning');
  });

  it('stores multiple rate limit types', () => {
    upsertRateLimit({
      status: 'allowed',
      rate_limit_type: 'five_hour',
      utilization: 0.18,
    });
    upsertRateLimit({
      status: 'allowed',
      rate_limit_type: 'seven_day',
      utilization: 0.26,
    });
    upsertRateLimit({
      status: 'allowed',
      rate_limit_type: 'seven_day_sonnet',
      utilization: 0.08,
    });
    const rows = getRateLimits();
    expect(rows).toHaveLength(3);
  });

  it('skips entries without rate_limit_type', () => {
    upsertRateLimit({ status: 'allowed' });
    const rows = getRateLimits();
    expect(rows).toHaveLength(0);
  });
});

describe('schema versioning', () => {
  it('fresh database has all migrations applied', () => {
    _initTestDatabase();
    expect(getSchemaVersion()).toBe(5);
  });

  it('schema_version table tracks applied migrations', () => {
    _initTestDatabase();
    const rows = getSchemaVersionHistory();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveProperty('version', 1);
    expect(rows[4]).toHaveProperty('version', 5);
    // Each row should have a valid applied_at timestamp
    for (const row of rows) {
      expect(row.applied_at).toBeTruthy();
      expect(new Date(row.applied_at).toISOString()).toBe(row.applied_at);
    }
  });

  it('migrations are idempotent - running twice is safe', () => {
    _initTestDatabase();
    // Re-initializing should not fail (simulates the old try-catch behavior)
    _initTestDatabase();
    expect(getSchemaVersion()).toBe(5);
  });
});

// --- Session CRUD ---

describe('session management', () => {
  it('stores and retrieves a session', () => {
    setSession('whatsapp_main', 'session-abc');
    expect(getSession('whatsapp_main')).toBe('session-abc');
  });

  it('returns undefined for unknown group', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });

  it('overwrites session on update', () => {
    setSession('whatsapp_main', 'session-old');
    setSession('whatsapp_main', 'session-new');
    expect(getSession('whatsapp_main')).toBe('session-new');
  });

  it('deletes a session', () => {
    setSession('whatsapp_main', 'session-abc');
    deleteSession('whatsapp_main');
    expect(getSession('whatsapp_main')).toBeUndefined();
  });

  it('deleteSession is a no-op for unknown group', () => {
    expect(() => deleteSession('nonexistent')).not.toThrow();
  });

  it('getAllSessions returns all stored sessions', () => {
    setSession('group_a', 'sess-1');
    setSession('group_b', 'sess-2');
    const all = getAllSessions();
    expect(all).toEqual({ group_a: 'sess-1', group_b: 'sess-2' });
  });

  it('getAllSessions excludes deleted sessions', () => {
    setSession('group_a', 'sess-1');
    setSession('group_b', 'sess-2');
    deleteSession('group_a');
    const all = getAllSessions();
    expect(all).toEqual({ group_b: 'sess-2' });
  });

  it('stale session recovery: delete clears session so next lookup returns undefined', () => {
    setSession('whatsapp_main', 'stale-session-xyz');
    expect(getSession('whatsapp_main')).toBe('stale-session-xyz');
    deleteSession('whatsapp_main');
    expect(getSession('whatsapp_main')).toBeUndefined();
    expect(getAllSessions()).toEqual({});
  });
});

// --- Session error detection pattern ---

describe('session error detection pattern', () => {
  const SESSION_ERROR_PATTERN = /session|conversation not found|resume/i;

  it('matches "No conversation found with session ID"', () => {
    expect(
      SESSION_ERROR_PATTERN.test(
        'No conversation found with session ID abc-123',
      ),
    ).toBe(true);
  });

  it('matches "session expired"', () => {
    expect(SESSION_ERROR_PATTERN.test('session expired')).toBe(true);
  });

  it('matches "failed to resume"', () => {
    expect(SESSION_ERROR_PATTERN.test('failed to resume conversation')).toBe(
      true,
    );
  });

  it('does not match unrelated errors', () => {
    expect(SESSION_ERROR_PATTERN.test('rate limit exceeded')).toBe(false);
    expect(SESSION_ERROR_PATTERN.test('network timeout')).toBe(false);
  });
});
