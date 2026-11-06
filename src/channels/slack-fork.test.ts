/**
 * Slack fork behaviours.
 *
 * Lives on main only, on purpose. slack.ts and slack-instances-registration
 * .test.ts are skill payloads: /update-nanoclaw's skill refresh replaces them
 * wholesale from the `channels` registry branch (origin first, then upstream).
 * If that refresh ever pulls upstream's copy, both the fork code and the
 * payload's own fork assertions vanish together and every test stays green.
 * This file is not a payload, so it survives the refresh and fails the
 * staged build/test instead, blocking cutover.
 *
 * What it pins:
 *   - Unthreaded, top-level replies (CLAUDE.md fork convention #5): both
 *     contexts declare threads:false and sessionMode 'shared'. A per-thread
 *     sessionMode alone would stamp threads=1 on every new wiring.
 *   - send_blocks: createSlackBridge hands the bridge a postBlocks that posts
 *     raw Block Kit through the adapter's web client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMessage = vi.fn();
const createChatSdkBridge = vi.fn();

vi.mock('@chat-adapter/slack', () => ({
  createSlackAdapter: () => ({ client: { chat: { postMessage } }, fetchThread: vi.fn() }),
}));
vi.mock('../env.js', () => ({
  readEnvFile: () => ({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: 'secret' }),
}));
vi.mock('./chat-sdk-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chat-sdk-bridge.js')>()),
  createChatSdkBridge: (opts: unknown) => {
    createChatSdkBridge(opts);
    return {};
  },
}));

import { resolveWiringDefaults } from './channel-defaults.js';
import { SLACK_DEFAULTS, createSlackBridge } from './slack.js';

type PostBlocks = (threadId: string, blocks: unknown[], fallbackText: string) => Promise<{ id?: string }>;

function bridgePostBlocks(): PostBlocks | undefined {
  createSlackBridge();
  const opts = createChatSdkBridge.mock.calls.at(-1)?.[0] as { postBlocks?: PostBlocks } | undefined;
  return opts?.postBlocks;
}

beforeEach(() => vi.clearAllMocks());

describe('Slack replies are unthreaded by default (fork convention #5)', () => {
  it('declares threads off and shared sessions for channels and DMs', () => {
    expect(SLACK_DEFAULTS.group).toMatchObject({ threads: false, sessionMode: 'shared' });
    expect(SLACK_DEFAULTS.dm).toMatchObject({ threads: false, sessionMode: 'shared' });
  });

  it('new channel and DM wirings are created unthreaded', () => {
    expect(resolveWiringDefaults('slack', true, 'Andy')).toMatchObject({ session_mode: 'shared', threads: null });
    expect(resolveWiringDefaults('slack', false, 'Andy')).toMatchObject({ session_mode: 'shared', threads: null });
  });
});

describe('send_blocks: createSlackBridge wires postBlocks', () => {
  it('passes a postBlocks function to the bridge', () => {
    expect(typeof bridgePostBlocks()).toBe('function');
  });

  it('posts raw Block Kit to the channel root, unfurls off', async () => {
    postMessage.mockResolvedValue({ ok: true, ts: '111.222' });
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];
    const result = await bridgePostBlocks()!('slack:C123:', blocks, 'hi');
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: undefined,
      text: 'hi',
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(result).toEqual({ id: '111.222' });
  });

  it('keeps a thread ts when the target is a thread', async () => {
    postMessage.mockResolvedValue({ ok: true, ts: '3' });
    await bridgePostBlocks()!('slack:C123:999.000', [], 'x');
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123', thread_ts: '999.000' }));
  });

  it('surfaces a Slack API error instead of reporting success', async () => {
    postMessage.mockResolvedValue({ ok: false, error: 'invalid_blocks' });
    await expect(bridgePostBlocks()!('slack:C123:', [], 'x')).rejects.toThrow('invalid_blocks');
  });

  it('rejects a non-Slack thread id', async () => {
    await expect(bridgePostBlocks()!('discord:C1:', [], 'x')).rejects.toThrow('non-Slack threadId');
  });
});
