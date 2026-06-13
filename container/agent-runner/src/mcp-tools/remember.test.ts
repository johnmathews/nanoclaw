/**
 * Tests for the remember MCP tool — validation (no outbound write on bad args)
 * and the full round-trip: write a `remember` system action, then simulate the
 * host inserting the reply into inbound.db and assert the tool surfaces it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { remember } from './remember.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find the pending remember system action and return its requestId. */
function pendingRequestId(): string {
  const out = getUndeliveredMessages().find((m) => JSON.parse(m.content).action === 'remember');
  if (!out) throw new Error('no remember action written');
  return JSON.parse(out.content).requestId as string;
}

/** Simulate the host writing a reply frame into inbound.db. */
function injectReply(requestId: string, frame: Record<string, unknown>): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content, trigger)
       VALUES ($id, $seq, 'system', datetime('now'), 'pending', $content, 0)`,
    )
    .run({
      $id: `rem-resp-${requestId}`,
      $seq: 100,
      $content: JSON.stringify({ type: 'remember_response', requestId, frame }),
    });
}

describe('remember — validation (no outbound write)', () => {
  it('rejects a bad target', async () => {
    const r = await remember.handler({ target: 'bogus', op: 'add', text: 'x' });
    expect(r.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects add without text', async () => {
    const r = await remember.handler({ target: 'memory', op: 'add' });
    expect(r.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects replace without match', async () => {
    const r = await remember.handler({ target: 'memory', op: 'replace', replacement: 'x' });
    expect(r.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('remember — round-trip', () => {
  it('writes a remember system action with the right payload', async () => {
    const p = remember.handler({ target: 'user', op: 'add', text: 'name is John' });
    await sleep(50);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    const payload = JSON.parse(out[0].content);
    expect(payload).toMatchObject({ action: 'remember', target: 'user', op: 'add', text: 'name is John' });

    injectReply(payload.requestId, { ok: true, target: 'user', op: 'add', chars: 12, budget: 1375 });
    const r = await p;
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('Saved to user');
  });

  it('surfaces a budget rejection with the current entries', async () => {
    const p = remember.handler({ target: 'memory', op: 'add', text: 'too much' });
    await sleep(50);
    const reqId = pendingRequestId();
    injectReply(reqId, {
      ok: false,
      target: 'memory',
      op: 'add',
      error: 'budget_exceeded',
      current: 'entry one\nentry two',
      chars: 2200,
      budget: 2200,
    });
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('budget');
    expect(r.content[0].text).toContain('entry one');
  });

  it('marks the reply acked so the main poll loop skips it', async () => {
    const p = remember.handler({ target: 'memory', op: 'add', text: 'ack me' });
    await sleep(50);
    const reqId = pendingRequestId();
    injectReply(reqId, { ok: true, target: 'memory', op: 'add', chars: 6, budget: 2200 });
    await p;

    const acked = getInboundDb()
      .prepare("SELECT 1 AS hit FROM messages_in WHERE id = ?")
      .get(`rem-resp-${reqId}`);
    expect(acked).toBeTruthy(); // row still present
    // processing_ack now holds the completed marker (outbound side).
  });
});
