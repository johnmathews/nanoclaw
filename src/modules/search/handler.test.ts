/**
 * search_history host handler.
 *
 * The load-bearing guarantee is isolation: results are hard-scoped to the
 * calling session's own agent_group_id, which is what lets the action be
 * registered `unguarded`. The rest pins the reply contract the container
 * polls for — deterministic id, and trigger:false so an inline tool reply
 * never wakes the agent.
 *
 * writeSessionMessage is mocked rather than writing a real mailbox: this
 * exercises the handler, not the mailbox plumbing (upstream's own pattern, see
 * container-restart.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWriteSessionMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
}));

import { closeSearchIndexDb, indexRows, initSearchIndexDb } from '../../db/search-index-db.js';
import type { Session } from '../../types.js';
import { handleSearchHistory } from './handler.js';

function session(agentGroupId = 'ag-A'): Session {
  return {
    id: 'sess-1',
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  } as Session;
}

/** The single write the handler makes, as (agentGroupId, sessionId, message). */
function writtenMessage(): { id: string; trigger?: boolean; content: string } {
  expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
  return mockWriteSessionMessage.mock.calls[0][2] as { id: string; trigger?: boolean; content: string };
}

function frame(): Record<string, unknown> {
  return JSON.parse(writtenMessage().content).frame;
}

beforeEach(() => {
  mockWriteSessionMessage.mockClear();
  const idx = initSearchIndexDb(':memory:');
  indexRows(idx, [
    { agentGroupId: 'ag-A', source: 'in', ref: 'a1', ts: '2026-06-13T00:00:00Z', body: 'discuss the rollout plan' },
    { agentGroupId: 'ag-B', source: 'in', ref: 'b1', ts: '2026-06-13T00:00:00Z', body: 'rollout for the other group' },
  ]);
});

afterEach(() => {
  closeSearchIndexDb();
});

describe('handleSearchHistory', () => {
  it('returns only the calling group’s rows, and never wakes the agent', async () => {
    await handleSearchHistory({ requestId: 'req1', query: 'rollout' }, session('ag-A'));
    const msg = writtenMessage();
    expect(msg.id).toBe('search-resp-req1');
    expect(msg.trigger).toBe(false);
    const f = frame();
    expect(f.ok).toBe(true);
    const results = f.results as Array<{ ref: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].ref).toBe('a1'); // ag-B's matching row is not reachable
  });

  it('writes the reply into the calling session', async () => {
    await handleSearchHistory({ requestId: 'req1', query: 'rollout' }, session('ag-A'));
    const [agentGroupId, sessionId] = mockWriteSessionMessage.mock.calls[0] as [string, string, unknown];
    expect(agentGroupId).toBe('ag-A');
    expect(sessionId).toBe('sess-1');
  });

  it('rejects an empty query', async () => {
    await handleSearchHistory({ requestId: 'req2', query: '   ' }, session());
    expect(frame()).toMatchObject({ ok: false, error: 'empty_query' });
  });

  it('reports index_unavailable when the index DB is not initialized', async () => {
    closeSearchIndexDb();
    await handleSearchHistory({ requestId: 'req3', query: 'rollout' }, session());
    expect(frame()).toMatchObject({ ok: false, error: 'index_unavailable' });
  });

  it('does nothing without a requestId', async () => {
    await handleSearchHistory({ query: 'rollout' }, session());
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('clamps the limit to the documented maximum', async () => {
    const idx = initSearchIndexDb(':memory:');
    indexRows(
      idx,
      Array.from({ length: 60 }, (_, i) => ({
        agentGroupId: 'ag-A',
        source: 'in' as const,
        ref: `r${i}`,
        ts: '2026-06-13T00:00:00Z',
        body: 'rollout',
      })),
    );
    await handleSearchHistory({ requestId: 'req4', query: 'rollout', limit: 999 }, session('ag-A'));
    expect((frame().results as unknown[]).length).toBeLessThanOrEqual(50);
  });
});
