/**
 * search_history MCP tool (learning & memory feature #2).
 *
 * Full-text search over this agent group's own conversation history: past user
 * messages, your past replies, and archived conversation transcripts. Useful
 * for "have we discussed X before?", recalling a past decision, or the weekly
 * reflection pass.
 *
 * The host owns the search index (data/v2-index.db) and the container can't
 * open it, so this is a round-trip tool — same shape as `remember`: write a
 * `search_history` system action to outbound.db, poll inbound.db for the
 * host's reply. Results are always scoped to your own agent group by the host.
 */
import { findResponseById, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const POLL_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function formatResults(query: string, results: SearchHit[]): string {
  if (results.length === 0) return `No matches for "${query}".`;
  const lines = results.map((r) => {
    const who = SOURCE_LABELS[r.source] ?? r.source;
    const when = r.ts ? r.ts.slice(0, 10) : '';
    return `- [${who}${when ? ` ${when}` : ''}] ${r.snippet.replace(/\s+/g, ' ').trim()}`;
  });
  return `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}":\n${lines.join('\n')}`;
}

export const searchHistory: McpToolDefinition = {
  tool: {
    name: 'search_history',
    description:
      'Full-text search over THIS agent group\'s own conversation history: past user messages, your past replies, and archived conversation transcripts. ' +
      'Use it to check whether something was discussed before, recall a past decision or fact, or gather context for a reflection. ' +
      'Results are always limited to your own group — you cannot see other groups\' conversations. ' +
      'Pass `query` (supports plain words; FTS5 operators like OR and "exact phrase" also work) and optionally `limit` (default 10, max 50). ' +
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
  async handler(args) {
    const query = (args.query as string) ?? '';
    if (!query.trim()) return err('search_history requires a non-empty `query`');
    let limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : DEFAULT_LIMIT;
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const requestId = generateId();
    const r = getSessionRouting();

    writeMessageOut({
      id: requestId,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ action: 'search_history', requestId, query, limit }),
    });

    log(`search_history: "${query}" limit=${limit} (${requestId})`);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const resp = findResponseById(`search-resp-${requestId}`);
      if (resp) {
        markCompleted([resp.id]);
        const frame = JSON.parse(resp.content).frame as SearchFrame;
        if (frame.ok) return ok(formatResults(query, frame.results ?? []));
        if (frame.error === 'index_unavailable') {
          return err('Conversation search is not available right now (index not ready).');
        }
        if (frame.error === 'empty_query') return err('search_history requires a non-empty `query`');
        return err(`search_history failed: ${frame.error ?? 'unknown'}`);
      }
      await sleep(500);
    }

    log(`search_history timeout: ${requestId}`);
    return err('search_history timed out waiting for the host (30s).');
  },
};

registerTools([searchHistory]);
