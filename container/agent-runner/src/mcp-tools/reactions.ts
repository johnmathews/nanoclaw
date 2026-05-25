/**
 * `query_reactions` MCP tool. Lives in its own module so the multimodal /
 * reactions port keeps an upstream-clean `core.ts` — see ./reactions.instructions.md
 * for the agent-facing usage notes.
 *
 * Reactions arrive as chat-sdk rows synthesised by
 * `chat-sdk-bridge.buildReactionInbound` on the host. The agent-runner side
 * does not understand reactions structurally — they're plain `messages_in`
 * rows with a `reaction` field inside `content` JSON. This tool reads those
 * rows out of the session's inbound DB for the agent.
 *
 * The query is per-session by construction (only reactions on messages in
 * this session's thread are routed here by the host), so there's no
 * cross-session leakage.
 *
 * Optional filter: `target_message_id` returns only reactions on that
 * specific platform message id (e.g. the agent's own reply ts on Slack).
 * Without it, returns the most recent N reactions across the session.
 *
 * Each row's `added` field is preserved verbatim so callers can recover
 * the live emoji set (an add followed by a remove for the same emoji is
 * a net-zero). Callers requiring "currently set" semantics should fold
 * the list themselves; the SDK can't infer it without re-fetching state
 * from the platform.
 */
import { getInboundDb } from '../db/connection.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const queryReactions: McpToolDefinition = {
  tool: {
    name: 'query_reactions',
    description:
      'List reactions the bridge has captured in this session. Optionally filter by `target_message_id` to inspect a single message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_message_id: {
          type: 'string',
          description: 'Platform message id (e.g. a Slack `ts`) to filter on. Omit to list across the session.',
        },
        limit: {
          type: 'integer',
          description: 'Max rows to return (default 50, max 500).',
        },
      },
    },
  },
  async handler(args) {
    const targetMessageId = typeof args.target_message_id === 'string' ? args.target_message_id : undefined;
    const limitArg = typeof args.limit === 'number' ? args.limit : 50;
    const limit = Math.max(1, Math.min(500, Math.floor(limitArg)));

    let rows: Array<{ id: string; timestamp: string; content: string }>;
    try {
      const db = getInboundDb();
      const sql = `SELECT id, timestamp, content
                   FROM messages_in
                   WHERE kind = 'chat-sdk'
                     AND content LIKE '%"reaction":%'
                   ORDER BY timestamp DESC
                   LIMIT ?`;
      rows = db.prepare(sql).all(limit * 4) as typeof rows;
    } catch (e) {
      return err(`Failed to read inbound DB: ${e instanceof Error ? e.message : String(e)}`);
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
    const entries: ReactionEntry[] = [];

    for (const r of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(r.content) as Record<string, unknown>;
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
        id: r.id,
        timestamp: r.timestamp,
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
