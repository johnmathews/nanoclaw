import { describe, expect, it } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { buildNcv2Inbound, createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

describe('buildNcv2Inbound', () => {
  // The bridge's chat.onAction handler synthesises an inbound row from
  // ncv2:-prefixed action events. The shape must satisfy: (a) text the
  // formatter can render verbatim into the agent prompt, (b) structured
  // metadata under content.action so the agent can extract the actionId and
  // value programmatically, and (c) isMention=true so a mention-mode wiring
  // still treats the click as agent-addressed.

  const baseInput = {
    actionId: 'confirm_delete',
    value: '',
    userId: 'U01HJOHN',
    userName: 'John',
    messageId: '1700000000.000300',
    now: () => new Date('2026-05-22T12:34:56Z'),
    idGen: () => 'act-test-1',
  } as const;

  it('produces a chat-sdk message with isMention=true and isGroup=true', () => {
    const inbound = buildNcv2Inbound({ ...baseInput });
    expect(inbound.kind).toBe('chat-sdk');
    expect(inbound.isMention).toBe(true);
    expect(inbound.isGroup).toBe(true);
    expect(inbound.id).toBe('act-test-1');
    expect(inbound.timestamp).toBe('2026-05-22T12:34:56.000Z');
  });

  it('builds a no-value text line for button clicks', () => {
    const inbound = buildNcv2Inbound({ ...baseInput, value: '' });
    const content = inbound.content as { text: string };
    expect(content.text).toBe('(button clicked) action_id="confirm_delete" by John');
  });

  it('includes value in the text line for select/checkbox clicks', () => {
    const inbound = buildNcv2Inbound({ ...baseInput, value: 'branch-a,branch-b' });
    const content = inbound.content as { text: string };
    expect(content.text).toBe('(button clicked) action_id="confirm_delete" value="branch-a,branch-b" by John');
  });

  it('embeds the structured action under content.action', () => {
    const inbound = buildNcv2Inbound({ ...baseInput, value: 'x' });
    const content = inbound.content as {
      action: { actionId: string; value: string; userId: string; messageId: string };
      senderId: string;
      sender: string;
    };
    expect(content.action.actionId).toBe('confirm_delete');
    expect(content.action.value).toBe('x');
    expect(content.action.userId).toBe('U01HJOHN');
    expect(content.action.messageId).toBe('1700000000.000300');
    expect(content.sender).toBe('John');
    expect(content.senderId).toBe('U01HJOHN');
  });
});

describe('createChatSdkBridge.deliver — raw Slack Block Kit (send_blocks)', () => {
  // send_blocks writes outbound rows shaped `{ type: 'blocks', blocks, fallbackText }`.
  // Slack supplies a `postBlocks` to the bridge config — other channels don't,
  // and the bridge falls back to posting the fallbackText so the message isn't lost.

  it('routes content.type=blocks through config.postBlocks when present', async () => {
    const { calls, postMessage } = makePostCapture();
    const blockCalls: Array<{ threadId: string; blocks: unknown[]; fallbackText: string }> = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: true,
      postBlocks: async (threadId, blocks, fallbackText) => {
        blockCalls.push({ threadId, blocks, fallbackText });
        return { id: 'slack-ts-99' };
      },
    });

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'hi' } },
      {
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: 'go' }, action_id: 'ncv2:confirm_delete' }],
      },
    ];
    const id = await bridge.deliver('slack:C12345', 'slack:C12345:1700.0001', {
      kind: 'chat-sdk',
      content: { type: 'blocks', blocks, fallbackText: 'hi (fallback)' },
    });

    expect(id).toBe('slack-ts-99');
    expect(blockCalls).toHaveLength(1);
    expect(blockCalls[0].threadId).toBe('slack:C12345:1700.0001');
    expect(blockCalls[0].blocks).toEqual(blocks);
    expect(blockCalls[0].fallbackText).toBe('hi (fallback)');
    // Adapter.postMessage must NOT have been called — the blocks took the direct path.
    expect(calls).toHaveLength(0);
  });

  it('falls back to posting fallbackText via the adapter when postBlocks is absent', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: true,
      // postBlocks omitted — simulates a non-Slack channel
    });

    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'blocks',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }],
        fallbackText: 'plain summary',
      },
    });

    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain summary');
  });

  it('falls back to fallbackText when postBlocks throws (preserves agent intent)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: true,
      postBlocks: async () => {
        throw new Error('WebClient: invalid_blocks');
      },
    });

    await bridge.deliver('slack:C12345', 'slack:C12345:1700.0001', {
      kind: 'chat-sdk',
      content: {
        type: 'blocks',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }],
        fallbackText: 'plain summary',
      },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain summary');
  });

  it('skips delivery (no crash) when blocks payload has empty fallbackText and no postBlocks', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: true,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'blocks', blocks: [{ type: 'section' }], fallbackText: '' },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch when blocks is not an array (defensive)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: true,
    });
    // `blocks: 'not an array'` is not what send_blocks would write, but if a future
    // tool emits a malformed row, the bridge should treat it as a normal text msg
    // (falls through to the bottom text branch) rather than entering the blocks path.
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'blocks', blocks: 'not an array', text: 'fallthrough text' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('fallthrough text');
  });
});
