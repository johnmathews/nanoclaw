/**
 * `query_reactions` MCP tool.
 *
 * Reactions are not a structural concept in the runner: the host synthesises
 * them as ordinary chat-sdk inbound rows carrying a `reaction` object in their
 * content JSON (chat-sdk-bridge.buildReactionInbound). This tool reads those
 * rows back and presents them.
 *
 * Scoped to this session's own mailbox by construction — only reactions on
 * messages in this session's thread are routed here — so there is no
 * cross-session read to guard against.
 *
 * `added` is preserved verbatim rather than folded into a "currently set"
 * view: an add followed by a remove of the same emoji is a net-zero, and
 * collapsing that here would quietly invent state. A caller that wants the
 * live set should fold the list itself, or re-read it from the platform.
 */
import { findReactionRows } from '../db/messages-in.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/**
 * Rows are filtered in JS after the SQL LIMIT, so over-fetch: a target filter
 * can discard most of what the query returned.
 */
const OVERFETCH = 4;

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface ReactionEntry {
  id: string;
  timestamp: string;
  emoji: string;
  rawEmoji: string;
  added: boolean;
  targetMessageId: string;
  userId: string;
  userName: string;
}

export const queryReactions: McpToolDefinition = {
  tool: {
    name: 'query_reactions',
    description:
      'List reactions captured in this session. Optionally filter by `target_message_id` to inspect one message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_message_id: {
          type: 'string',
          description: 'Platform message id (e.g. a Slack `ts`) to filter on. Omit to list across the session.',
        },
        limit: {
          type: 'integer',
          description: `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
    },
  },
  async handler(args) {
    const targetMessageId = typeof args.target_message_id === 'string' ? args.target_message_id : undefined;
    const requested = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));

    let rows;
    try {
      rows = findReactionRows(limit * OVERFETCH);
    } catch (e) {
      return err(`Failed to read the mailbox: ${e instanceof Error ? e.message : String(e)}`);
    }

    const entries: ReactionEntry[] = [];
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.content) as Record<string, unknown>;
      } catch {
        continue;
      }
      const reaction = parsed.reaction as
        | { emoji?: string; rawEmoji?: string; added?: boolean; targetMessageId?: string; userId?: string }
        | undefined;
      if (!reaction || typeof reaction !== 'object') continue;
      if (typeof reaction.targetMessageId !== 'string') continue;
      if (targetMessageId && reaction.targetMessageId !== targetMessageId) continue;

      entries.push({
        id: row.id,
        timestamp: row.timestamp,
        emoji: String(reaction.emoji ?? ''),
        rawEmoji: String(reaction.rawEmoji ?? reaction.emoji ?? ''),
        added: reaction.added !== false,
        targetMessageId: reaction.targetMessageId,
        userId: String(reaction.userId ?? ''),
        userName: typeof parsed.sender === 'string' ? parsed.sender : String(reaction.userId ?? ''),
      });
      if (entries.length >= limit) break;
    }

    if (entries.length === 0) {
      return ok(
        targetMessageId
          ? `No reactions recorded for message ${targetMessageId} in this session.`
          : 'No reactions recorded in this session.',
      );
    }
    return ok(JSON.stringify({ count: entries.length, reactions: entries }, null, 2));
  },
};

registerTools([queryReactions]);
