/**
 * Tests for the search_history MCP tool — validation (no outbound write on bad
 * args), the round-trip payload + reply surfacing, and poll-timeout behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { searchHistory } from './search_history.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pendingRequest(): { requestId: string; query: string; limit: number } {
  const out = getUndeliveredMessages().find((m) => JSON.parse(m.content).action === 'search_history');
  if (!out) throw new Error('no search_history action written');
  const c = JSON.parse(out.content);
  return { requestId: c.requestId as string, query: c.query as string, limit: c.limit as number };
}

function injectReply(requestId: string, frame: Record<string, unknown>): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger)
       VALUES ($id, $seq, 'system', datetime('now'), 'pending', $content, 0)`,
    )
    .run({
      $id: `search-resp-${requestId}`,
      $seq: 200,
      $content: JSON.stringify({ type: 'search_history_response', requestId, frame }),
    });
}

describe('search_history — validation', () => {
  it('rejects an empty query with no outbound write', async () => {
    const r = await searchHistory.handler({ query: '   ' });
    expect(r.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('search_history — round-trip', () => {
  it('writes the request payload and clamps the limit', async () => {
    const p = searchHistory.handler({ query: 'rollout plan', limit: 999 });
    await sleep(50);
    const req = pendingRequest();
    expect(req.query).toBe('rollout plan');
    expect(req.limit).toBe(50); // clamped to max

    injectReply(req.requestId, {
      ok: true,
      query: 'rollout plan',
      results: [{ source: 'out', ref: 'out:s1:m3', ts: '2026-06-13T10:00:00Z', snippet: 'the «rollout» plan is set' }],
    });
    const r = await p;
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('1 match');
    expect(r.content[0].text).toContain('rollout');
    expect(r.content[0].text).toContain('[you 2026-06-13]');
  });

  it('formats a no-match reply', async () => {
    const p = searchHistory.handler({ query: 'nonexistent' });
    await sleep(50);
    const req = pendingRequest();
    injectReply(req.requestId, { ok: true, query: 'nonexistent', results: [] });
    const r = await p;
    expect(r.content[0].text).toContain('No matches');
  });

  it('surfaces index_unavailable as a friendly error', async () => {
    const p = searchHistory.handler({ query: 'anything' });
    await sleep(50);
    const req = pendingRequest();
    injectReply(req.requestId, { ok: false, error: 'index_unavailable' });
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('not available');
  });
});
