import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// Emoji used as a reaction on the triggering message while the agent works
const WORKING_REACTION = 'eyes';

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  private workingReactions = new Map<string, string>(); // channelId → message ts (for removing reaction)

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens from .env (not process.env — keeps secrets off the environment
    // so they don't leak to child processes, matching NanoClaw's security pattern)
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set in .env',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Acknowledge checkbox interactions (Slack requires ack within 3s; actual
    // processing happens when the user clicks the confirm button)
    this.app.action(/^nanoclaw_checkbox_/, async ({ ack }) => {
      await ack();
    });

    // Handle "Confirm Delete" button clicks — extract selected branches from
    // checkbox state and deliver a synthetic inbound message to the agent
    this.app.action(/^nanoclaw_confirm_/, async ({ ack, body }) => {
      await ack();

      // Extract selected options from all checkbox blocks in the message state
      const stateValues = (
        body as {
          state?: {
            values?: Record<
              string,
              Record<string, { selected_options?: Array<{ value: string }> }>
            >;
          };
        }
      ).state?.values;
      if (!stateValues) return;

      const selectedBranches: string[] = [];
      for (const blockValues of Object.values(stateValues)) {
        for (const [actionId, action] of Object.entries(blockValues)) {
          if (
            actionId.startsWith('nanoclaw_checkbox_') &&
            action.selected_options
          ) {
            for (const opt of action.selected_options) {
              selectedBranches.push(opt.value);
            }
          }
        }
      }

      if (selectedBranches.length === 0) return;

      // Determine the channel JID from the action payload
      const channelId = (body as { channel?: { id?: string } }).channel?.id;
      if (!channelId) return;

      const jid = `slack:${channelId}`;
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      // Send immediate confirmation so the user knows the click registered
      const branchList = selectedBranches.map((b) => `\`${b}\``).join(', ');
      await this.sendMessage(
        jid,
        `Deleting ${selectedBranches.length} branch${selectedBranches.length === 1 ? '' : 'es'}: ${branchList}...`,
      );

      // Deliver as a synthetic inbound message so the agent processes it
      const syntheticText = `@${ASSISTANT_NAME} delete branches: ${selectedBranches.join(', ')}`;
      this.opts.onMessage(jid, {
        id: `action-${Date.now()}`,
        chat_jid: jid,
        sender: (body as { user?: { id?: string } }).user?.id || 'unknown',
        sender_name:
          (body as { user?: { name?: string } }).user?.name || 'unknown',
        content: syntheticText,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });

      logger.info(
        { jid, branches: selectedBranches },
        'Block Kit confirm action: synthetic delete message delivered',
      );
    });

    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      // Threaded replies are flattened into the channel conversation.
      // The agent sees them alongside channel-level messages; responses
      // always go to the channel, not back into the thread.

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;

      let senderName: string;
      if (isBotMessage) {
        senderName = ASSISTANT_NAME;
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncChannelMetadata();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      // Remove the working reaction now that the real response is arriving
      this.removeWorkingReaction(channelId);

      // Slack limits messages to ~4000 characters; split if needed
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({ channel: channelId, text });
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  async sendBlocks(
    jid: string,
    blocks: unknown[],
    fallbackText: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      // Fall back to text-only when disconnected
      this.outgoingQueue.push({
        jid,
        text: fallbackText || 'Block Kit message (view in Slack)',
      });
      logger.info(
        { jid },
        'Slack disconnected, blocks queued as text fallback',
      );
      return;
    }

    // Remove the working reaction now that the real response is arriving
    this.removeWorkingReaction(channelId);

    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: fallbackText,
        blocks: blocks as [],
      });
      logger.info({ jid }, 'Slack blocks message sent');
    } catch (err) {
      logger.warn(
        { jid, err },
        'Failed to send Slack blocks, falling back to text',
      );
      await this.sendMessage(
        jid,
        fallbackText || 'Block Kit message failed to render.',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    messageTs?: string,
  ): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (isTyping) {
      // Add a reaction to the triggering message to indicate the agent is working.
      // Reactions don't trigger notifications — unlike posting a message.
      const ts = messageTs || this.workingReactions.get(channelId);
      if (!ts) return;
      try {
        await this.app.client.reactions.add({
          channel: channelId,
          timestamp: ts,
          name: WORKING_REACTION,
        });
        this.workingReactions.set(channelId, ts);
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to add working reaction');
      }
    } else {
      // Agent finished — remove the reaction
      this.removeWorkingReaction(channelId);
    }
  }

  /**
   * Remove the working reaction from the triggering message (fire-and-forget).
   */
  private removeWorkingReaction(channelId: string): void {
    const ts = this.workingReactions.get(channelId);
    if (!ts) return;
    this.workingReactions.delete(channelId);
    this.app.client.reactions
      .remove({
        channel: channelId,
        timestamp: ts,
        name: WORKING_REACTION,
      })
      .catch((err) => {
        logger.debug({ channelId, err }, 'Failed to remove working reaction');
      });
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   */
  async syncChannelMetadata(): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            updateChatName(`slack:${ch.id}`, ch.name);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  if (!envVars.SLACK_BOT_TOKEN || !envVars.SLACK_APP_TOKEN) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
