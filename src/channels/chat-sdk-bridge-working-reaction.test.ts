/**
 * Fork: the working-marker reaction (Slack 👀 while the agent works).
 *
 * - markWorking / clearWorking add and remove the configured reaction, only in
 *   unthreaded chats and only for ids the channel says are real messages.
 * - Without `workingReaction` the bridge exposes neither method, so other
 *   channels are untouched.
 * - The platform's echo of the bridge's own reaction is dropped before it can
 *   be routed to an agent (it would wake the agent and could loop), while a
 *   human's reaction still routes. Driven through the real Chat SDK dispatch
 *   (`chat.processReaction`), as in chat-sdk-bridge-byline.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge, WORKING_REACTION_ECHO_MS, WorkingReactionEchoGuard } from './chat-sdk-bridge.js';

type ReactionCall = { op: 'add' | 'remove'; threadId: string; messageId: string; emoji: string };

function makeAdapter(calls: ReactionCall[]): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    addReaction: async (threadId: string, messageId: string, emoji: string) => {
      calls.push({ op: 'add', threadId, messageId, emoji });
    },
    removeReaction: async (threadId: string, messageId: string, emoji: string) => {
      calls.push({ op: 'remove', threadId, messageId, emoji });
    },
  } as unknown as Adapter;
}

const isTs = (id: string) => /^\d+\.\d+$/.test(id);

beforeEach(async () => {
  captured.chat = null;
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('working reaction — add/remove', () => {
  it('reacts to the inbound message in an unthreaded chat and removes it again', async () => {
    const calls: ReactionCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: makeAdapter(calls),
      supportsThreads: true,
      workingReaction: { emoji: 'eyes', isMarkable: isTs },
    });

    await bridge.markWorking!('slack:C1', null, '1794003907.745989');
    await bridge.clearWorking!('slack:C1', null, '1794003907.745989');

    expect(calls).toEqual([
      { op: 'add', threadId: 'slack:C1', messageId: '1794003907.745989', emoji: 'eyes' },
      { op: 'remove', threadId: 'slack:C1', messageId: '1794003907.745989', emoji: 'eyes' },
    ]);
  });

  it('does nothing in a threaded chat (the native thread status covers it)', async () => {
    const calls: ReactionCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: makeAdapter(calls),
      supportsThreads: true,
      workingReaction: { emoji: 'eyes', isMarkable: isTs },
    });

    await bridge.markWorking!('slack:C1', 'slack:C1:1794003907.745989', '1794003907.745989');
    await bridge.clearWorking!('slack:C1', 'slack:C1:1794003907.745989', '1794003907.745989');

    expect(calls).toEqual([]);
  });

  it('skips ids that are not real platform messages (synthetic reaction rows)', async () => {
    const calls: ReactionCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: makeAdapter(calls),
      supportsThreads: true,
      workingReaction: { emoji: 'eyes', isMarkable: isTs },
    });

    await bridge.markWorking!('slack:C1', null, 'rxn-1794003907-abc123');

    expect(calls).toEqual([]);
  });

  it('exposes no working-marker methods when the channel did not opt in', () => {
    const bridge = createChatSdkBridge({ adapter: makeAdapter([]), supportsThreads: true });
    expect(bridge.markWorking).toBeUndefined();
    expect(bridge.clearWorking).toBeUndefined();
  });
});

describe('WorkingReactionEchoGuard', () => {
  it('recognises its own emoji on a noted message, only within the echo window', () => {
    let now = 1_000_000;
    const guard = new WorkingReactionEchoGuard('eyes', () => now);
    guard.note('1.1');

    expect(guard.isEcho('1.1', 'eyes')).toBe(true);
    expect(guard.isEcho('1.1', 'thumbsup')).toBe(false);
    expect(guard.isEcho('2.2', 'eyes')).toBe(false);
    expect(guard.isEcho(undefined, 'eyes')).toBe(false);

    now += WORKING_REACTION_ECHO_MS + 1;
    expect(guard.isEcho('1.1', 'eyes')).toBe(false);
  });
});

describe('working reaction — echo is not routed to the agent', () => {
  async function setupBridge() {
    const calls: ReactionCall[] = [];
    const adapter = makeAdapter(calls);
    const inbound: unknown[] = [];
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      workingReaction: { emoji: 'eyes', isMarkable: isTs },
    });
    await bridge.setup({
      onInbound: async (...args: unknown[]) => {
        inbound.push(args);
      },
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as unknown as ChannelSetup);
    const chat = captured.chat as Chat;
    expect(chat).toBeTruthy();
    return { bridge, adapter, chat, inbound };
  }

  async function react(chat: Chat, adapter: Adapter, messageId: string, emoji: string, userId: string) {
    chat.processReaction(
      {
        adapter,
        emoji: emoji as never,
        rawEmoji: emoji,
        added: true,
        messageId,
        threadId: 'stub-thread',
        user: { userId, userName: userId, fullName: userId, isBot: false, isMe: false } as never,
        raw: {},
      } as never,
      undefined,
    );
    // processReaction is fire-and-forget; let its task settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('drops the echo of the bridge’s own 👀 even when the SDK cannot tell it is the bot', async () => {
    const { bridge, adapter, chat, inbound } = await setupBridge();
    await bridge.markWorking!('slack:C1', null, '1794003907.745989');

    // isMe:false simulates chat-sdk not knowing the bot user id.
    await react(chat, adapter, '1794003907.745989', 'eyes', 'UBOT');

    expect(inbound).toEqual([]);
  });

  it('still routes a human reaction (control: the dispatch path really delivers)', async () => {
    const { adapter, chat, inbound } = await setupBridge();

    await react(chat, adapter, '1794003907.745989', 'thumbsup', 'UHUMAN');

    expect(inbound).toHaveLength(1);
  });
});
