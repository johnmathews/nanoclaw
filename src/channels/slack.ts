/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type PostBlocksFn } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Minimal structural type for the `@slack/web-api` WebClient — only the
 * `chat.postMessage` call surface used by `send_blocks`. The Chat SDK Slack
 * adapter (v4.26.0) keeps an instance on its private `client` field.
 */
interface SlackWebClient {
  chat: {
    postMessage(args: {
      channel: string;
      thread_ts?: string;
      text: string;
      blocks?: unknown[];
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    }): Promise<{ ok?: boolean; ts?: string; channel?: string; error?: string }>;
  };
}

/**
 * Build a `postBlocks` function from a Slack adapter instance. Reaches into
 * the adapter's private `client` because the Chat SDK's `postMessage` only
 * accepts `AdapterPostableMessage` (string | Postable{Raw,Markdown,Ast,Card})
 * — none of which can carry raw Block Kit. Returns `null` when the adapter
 * shape doesn't match (e.g. future adapter version renames `client`), so the
 * bridge falls back to fallbackText instead of crashing.
 */
function makeSlackPostBlocks(slackAdapter: unknown): PostBlocksFn | null {
  const client = (slackAdapter as { client?: SlackWebClient }).client;
  if (!client?.chat || typeof client.chat.postMessage !== 'function') {
    log.warn('Slack adapter has no .client.chat.postMessage; send_blocks will fall back to text');
    return null;
  }
  return async (threadId, blocks, fallbackText) => {
    // threadId format is "slack:CHANNEL:THREAD_TS" (or "slack:CHANNEL:" for
    // non-thread). See @chat-adapter/slack decodeThreadId.
    const parts = threadId.split(':');
    if (parts.length < 2 || parts[0] !== 'slack') {
      throw new Error(`postBlocks called with non-Slack threadId: ${threadId}`);
    }
    const channel = parts[1];
    const threadTs = parts.length === 3 && parts[2] ? parts[2] : undefined;
    const result = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!result.ok) throw new Error(`Slack chat.postMessage failed: ${result.error ?? 'unknown'}`);
    return { id: result.ts };
  };
}

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    const postBlocks = makeSlackPostBlocks(slackAdapter) ?? undefined;
    const bridge = createChatSdkBridge({
      adapter: slackAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      postBlocks,
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
});
