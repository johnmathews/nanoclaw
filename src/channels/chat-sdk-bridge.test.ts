import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

// Stub readEnvFile so the production .env's OPENAI_API_KEY doesn't leak
// into the maybeTranscribe "no-key" branch tests below.
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import {
  buildNcv2Inbound,
  buildReactionInbound,
  createChatSdkBridge,
  maybePdfExtract,
  maybeTranscribe,
  splitForLimit,
} from './chat-sdk-bridge.js';
import { resetTranscriptionCacheForTests } from '../transcription.js';

const ORIGINAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

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

describe('createChatSdkBridge — instance identity', () => {
  it('default: name === channelType === adapter.name, instance undefined', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBeUndefined();
  });

  it('named instance: name follows the instance, channelType stays the platform', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack-tester');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBe('slack-tester');
  });

  it('rejects instance names that would break the webhook route or state delimiter', () => {
    for (const bad of ['a/b', 'a:b', 'a?b', 'a b']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });

  it('rejects empty and whitespace-only instance names (config bug — fail loud)', () => {
    // '' is falsy: a truthiness guard would skip it, dead-ending the
    // webhook route ('/webhook/' + '') and collapsing the state namespace
    // into the default instance's unprefixed keyspace — the exact
    // cross-bot dedupe/lock collisions the namespace exists to prevent.
    for (const bad of ['', ' ', '   ', '\t']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });
});

describe('createChatSdkBridge.setup — webhook route and state namespace', () => {
  // Real setup() over a stub adapter: Chat.initialize() needs a working
  // StateAdapter (chat_sdk_* tables) and an adapter.initialize — nothing
  // platform-side. registerWebhookAdapter is mocked at module level so we
  // can assert the (chat, adapterName, routingPath) triple.
  function setupStubAdapter(): Adapter {
    return stubAdapter({
      name: 'slack',
      initialize: async () => {},
    } as unknown as Partial<Adapter>);
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    runMigrations(initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    closeDb();
  });

  const hostConfig = {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };

  it('named instance registers the webhook with adapterName as handler key and instance as route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath).toBe('slack-tester');
    await bridge.teardown();
  });

  it('default instance registers the historical route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath ?? adapterName).toBe('slack');
    await bridge.teardown();
  });

  it('named instance namespaces Chat SDK state; default stays unprefixed (live-install constraint)', async () => {
    const { getDb } = await import('../db/connection.js');

    const named = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    await named.subscribe!('slack:C1', 'slack:T1');

    const def = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await def.setup(hostConfig);
    await def.subscribe!('slack:C1', 'slack:T1');

    const rows = getDb().prepare('SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id').all() as Array<{
      thread_id: string;
    }>;
    expect(rows.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1', 'slack:T1']);

    await named.teardown();
    await def.teardown();
  });

  it('explicitly naming the primary instance after the platform stays on the unprefixed keyspace', async () => {
    const { getDb } = await import('../db/connection.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack', // explicit, but equal to adapter.name ⇒ default keyspace
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:T9');
    const rows = getDb().prepare('SELECT thread_id FROM chat_sdk_subscriptions').all() as Array<{
      thread_id: string;
    }>;
    expect(rows.map((r) => r.thread_id)).toEqual(['slack:T9']);
    await bridge.teardown();
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

describe('buildReactionInbound', () => {
  // Reactions are routed via chat.onReaction → buildReactionInbound →
  // setupConfig.onInbound. The inbound shape must: (a) produce a
  // human-readable `text` so the formatter renders verbatim, (b) preserve
  // the structured reaction payload so a future query_reactions tool can
  // filter on targetMessageId/added, and (c) carry isMention=false so
  // mention-required channels store-as-context without waking the agent.

  const base = {
    emoji: '👍',
    rawEmoji: '+1',
    added: true,
    targetMessageId: '1700000000.000300',
    threadId: 'C-CHAN-1',
    userId: 'U01HJOHN',
    userName: 'John',
    now: () => new Date('2026-05-22T12:34:56Z'),
    idGen: () => 'rxn-test-1',
  } as const;

  it('produces a chat-sdk message with isMention=false and isGroup=true', () => {
    const inbound = buildReactionInbound({ ...base });
    expect(inbound.kind).toBe('chat-sdk');
    expect(inbound.isMention).toBe(false);
    expect(inbound.isGroup).toBe(true);
    expect(inbound.id).toBe('rxn-test-1');
    expect(inbound.timestamp).toBe('2026-05-22T12:34:56.000Z');
  });

  it('renders the added text with the emoji, reactor, and target id', () => {
    const inbound = buildReactionInbound({ ...base });
    const content = inbound.content as { text: string };
    expect(content.text).toBe('[John reacted 👍 on message 1700000000.000300]');
  });

  it('renders the removed text when added=false', () => {
    const inbound = buildReactionInbound({ ...base, added: false });
    const content = inbound.content as { text: string };
    expect(content.text).toBe('[John removed reaction 👍 on message 1700000000.000300]');
  });

  it('embeds the structured reaction payload under content.reaction', () => {
    const inbound = buildReactionInbound({ ...base });
    const content = inbound.content as {
      reaction: {
        emoji: string;
        rawEmoji: string;
        added: boolean;
        targetMessageId: string;
        threadId: string;
        userId: string;
      };
      sender: string;
      senderId: string;
    };
    expect(content.reaction.emoji).toBe('👍');
    expect(content.reaction.rawEmoji).toBe('+1');
    expect(content.reaction.added).toBe(true);
    expect(content.reaction.targetMessageId).toBe('1700000000.000300');
    expect(content.reaction.threadId).toBe('C-CHAN-1');
    expect(content.reaction.userId).toBe('U01HJOHN');
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

describe('maybeTranscribe', () => {
  // maybeTranscribe is the wrapper messageToInbound calls per attachment
  // after fetchData(). Verifies the wrapper's mime guard, error capture,
  // and entry mutation contract. The underlying Whisper call is exercised
  // exhaustively by src/transcription.test.ts; here we just sanity-check
  // the branching.

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    resetTranscriptionCacheForTests();
  });

  afterEach(() => {
    if (ORIGINAL_OPENAI_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
    resetTranscriptionCacheForTests();
  });

  it('is a no-op for non-audio mime types', async () => {
    const entry = { mimeType: 'image/png', name: 'pic.png' } as Record<string, unknown>;
    await maybeTranscribe(entry, Buffer.from('not audio'));
    expect(entry.transcription).toBeUndefined();
    expect(entry.transcriptionError).toBeUndefined();
  });

  it('is a no-op when mimeType is missing', async () => {
    const entry = { name: 'unknown' } as Record<string, unknown>;
    await maybeTranscribe(entry, Buffer.from('audio'));
    expect(entry.transcription).toBeUndefined();
    expect(entry.transcriptionError).toBeUndefined();
  });

  it('captures transcriptionError when OPENAI_API_KEY is missing', async () => {
    const entry = { mimeType: 'audio/ogg', name: 'v.ogg' } as Record<string, unknown>;
    await maybeTranscribe(entry, Buffer.from('audio'));
    expect(entry.transcriptionError).toContain('OPENAI_API_KEY not set');
    expect(entry.transcription).toBeUndefined();
  });
});

describe('maybePdfExtract', () => {
  // Same shape as maybeTranscribe: thin wrapper, mime guard, error capture.
  // The underlying pdftotext spawn is exercised by src/pdf-extract.test.ts;
  // here we sanity-check the wrapper.

  it('is a no-op for non-PDF mime types', async () => {
    const entry = { mimeType: 'image/png', name: 'pic.png' } as Record<string, unknown>;
    await maybePdfExtract(entry, Buffer.from('not pdf'));
    expect(entry.extractedText).toBeUndefined();
    expect(entry.pdfExtractionError).toBeUndefined();
  });

  it('is a no-op when mimeType is missing', async () => {
    const entry = { name: 'unknown' } as Record<string, unknown>;
    await maybePdfExtract(entry, Buffer.from('something'));
    expect(entry.extractedText).toBeUndefined();
    expect(entry.pdfExtractionError).toBeUndefined();
  });

  it('captures pdfExtractionError for an empty PDF buffer', async () => {
    const entry = { mimeType: 'application/pdf', name: 'broken.pdf' } as Record<string, unknown>;
    await maybePdfExtract(entry, Buffer.alloc(0));
    expect(entry.pdfExtractionError).toContain('Empty PDF buffer');
    expect(entry.extractedText).toBeUndefined();
  });
});
