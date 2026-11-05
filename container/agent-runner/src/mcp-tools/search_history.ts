/**
 * `search_history` MCP tool — the container half of the round-trip whose host
 * half is src/modules/search/ (stage 4a).
 *
 * Full-text search over this agent group's own conversation history: past user
 * messages, the agent's past replies, and archived conversation transcripts.
 *
 * The host owns the search index (data/v2-index.db) and the container cannot
 * open it, so the tool writes a `search_history` system action to the outbound
 * mailbox and polls inbound for the host's reply. The reply id is deterministic
 * (`search-resp-<requestId>`) and the row is `kind: 'system'`, which the poll
 * loop never hands to the agent (poll-loop.ts filters system rows), so it
 * waits here for the tool instead of being consumed as a turn. Results are
 * scoped to the calling agent group by the host; nothing here can widen that.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { getMessageIn, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Mutable so tests can shorten the wait; production values are fixed here. */
export const searchHistoryTiming = { timeoutMs: 30_000, pollMs: 500 };

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `srch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface SearchHit {
  source: string;
  ref: string;
  ts: string;
  snippet: string;
}

interface SearchFrame {
  ok: boolean;
  error?: string;
  query?: string;
  results?: SearchHit[];
}

const SOURCE_LABELS: Record<string, string> = {
  in: 'user',
  out: 'you',
  conversation: 'transcript',
};

export function formatResults(query: string, results: SearchHit[]): string {
  if (results.length === 0) return `No matches for "${query}".`;
  const lines = results.map((r) => {
    const who = SOURCE_LABELS[r.source] ?? r.source;
    const when = r.ts ? r.ts.slice(0, 10) : '';
    return `- [${who}${when ? ` ${when}` : ''}] ${r.snippet.replace(/\s+/g, ' ').trim()}`;
  });
  return `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}":\n${lines.join('\n')}`;
}

export function clampLimit(raw: unknown): number {
  let limit = typeof raw === 'number' ? Math.trunc(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export const searchHistory: McpToolDefinition = {
  tool: {
    name: 'search_history',
    description:
      "Full-text search over THIS agent group's own conversation history: past user messages, your past replies, and archived conversation transcripts. " +
      'Use it to check whether something was discussed before, recall a past decision or fact, or gather context for a reflection. ' +
      "Results are always limited to your own group — you cannot see other groups' conversations. " +
      'Pass `query` (plain words; FTS5 operators like OR and "exact phrase" also work) and optionally `limit` (default 10, max 50). ' +
      'Returns ranked snippets with their source and date. Recent in-session context is already in your prompt — use this for older or compacted history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search terms (words, OR, or "exact phrase")' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50)' },
      },
      required: ['query'],
    },
  },
  async handler(args, context) {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return err('search_history requires a non-empty `query`');
    const limit = clampLimit(args.limit);

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'search_history', requestId, query, limit }),
    });
    log(`search_history: "${query}" limit=${limit} (${requestId})`);

    const responseId = `search-resp-${requestId}`;
    const deadline = Date.now() + searchHistoryTiming.timeoutMs;
    while (Date.now() < deadline) {
      if (context?.signal.aborted) return err('search_history cancelled');
      const resp = getMessageIn(responseId);
      if (resp) {
        markCompleted([resp.id]);
        let frame: SearchFrame;
        try {
          frame = (JSON.parse(resp.content) as { frame: SearchFrame }).frame;
        } catch {
          return err('search_history got an unreadable reply from the host');
        }
        if (frame?.ok) return ok(formatResults(query, frame.results ?? []));
        if (frame?.error === 'index_unavailable') {
          return err('Conversation search is not available right now (index not ready).');
        }
        if (frame?.error === 'empty_query') return err('search_history requires a non-empty `query`');
        return err(`search_history failed: ${frame?.error ?? 'unknown'}`);
      }
      try {
        await sleep(searchHistoryTiming.pollMs, undefined, { signal: context?.signal });
      } catch (e) {
        if (context?.signal.aborted) return err('search_history cancelled');
        throw e;
      }
    }

    log(`search_history timeout: ${requestId}`);
    return err(`search_history timed out waiting for the host (${Math.round(searchHistoryTiming.timeoutMs / 1000)}s).`);
  },
};

registerTools([searchHistory]);
