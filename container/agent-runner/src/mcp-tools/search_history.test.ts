/**
 * search_history — the container half of the round-trip.
 *
 * A fake host watches outbound for the system action and answers in inbound
 * with the deterministic `search-resp-<requestId>` row, the same shape
 * src/modules/search/handler.ts writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { clampLimit, formatResults, searchHistory, searchHistoryTiming } from './search_history.js';

const original = { ...searchHistoryTiming };

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content[0]?.text ?? '';
}

function outboundAction(): { id: string; content: Record<string, unknown> } | undefined {
  const row = getOutboundDb().prepare("SELECT id, content FROM messages_out WHERE kind = 'system'").get() as {
    id: string;
    content: string;
  } | null;
  return row ? { id: row.id, content: JSON.parse(row.content) } : undefined;
}

/** Answer the first search_history action once it appears, as the host would. */
async function fakeHost(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const action = outboundAction();
    if (action) {
      const requestId = action.content.requestId as string;
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
           VALUES (?, 2, 'system', '2026-11-05T09:00:00.000Z', 'pending', 0, ?)`,
        )
        .run(`search-resp-${requestId}`, JSON.stringify({ type: 'search_history_response', requestId, frame }));
      return action.content;
    }
    await Bun.sleep(5);
  }
  throw new Error('no search_history action was written');
}

beforeEach(() => {
  initTestSessionDb();
  searchHistoryTiming.timeoutMs = 2_000;
  searchHistoryTiming.pollMs = 10;
});

afterEach(() => {
  closeSessionDb();
  Object.assign(searchHistoryTiming, original);
});

describe('search_history', () => {
  it('writes the system action the host handler expects and formats the reply', async () => {
    const [res, action] = await Promise.all([
      searchHistory.handler({ query: 'dentist', limit: 5 }),
      fakeHost({
        ok: true,
        query: 'dentist',
        results: [
          { source: 'in', ref: 'm1', ts: '2026-10-01T10:00:00Z', snippet: 'book the  dentist\nfor Tuesday' },
          { source: 'conversation', ref: 'c1', ts: '2026-09-02T08:00:00Z', snippet: 'dentist moved' },
        ],
      }),
    ]);
    expect(action).toMatchObject({ action: 'search_history', query: 'dentist', limit: 5 });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toBe(
      '2 matches for "dentist":\n- [user 2026-10-01] book the dentist for Tuesday\n- [transcript 2026-09-02] dentist moved',
    );
  });

  it('marks the reply completed so it is not left pending', async () => {
    await Promise.all([searchHistory.handler({ query: 'x' }), fakeHost({ ok: true, query: 'x', results: [] })]);
    const ack = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id LIKE ?')
      .get('search-resp-%') as { status: string } | undefined;
    expect(ack?.status).toBe('completed');
  });

  it('maps index_unavailable to a readable error', async () => {
    const [res] = await Promise.all([
      searchHistory.handler({ query: 'x' }),
      fakeHost({ ok: false, error: 'index_unavailable', query: 'x' }),
    ]);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('not available right now');
  });

  it('rejects an empty query without writing anything', async () => {
    const res = await searchHistory.handler({ query: '   ' });
    expect(res.isError).toBe(true);
    expect(outboundAction()).toBeUndefined();
  });

  it('times out when the host never answers', async () => {
    searchHistoryTiming.timeoutMs = 50;
    const res = await searchHistory.handler({ query: 'x' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('timed out');
  });

  it('clamps limit to 1..50 with a default of 10', () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(0)).toBe(10);
    expect(clampLimit(-3)).toBe(10);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(500)).toBe(50);
  });

  it('formats an empty result set', () => {
    expect(formatResults('nothing', [])).toBe('No matches for "nothing".');
  });
});
