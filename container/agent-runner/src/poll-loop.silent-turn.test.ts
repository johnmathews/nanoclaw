/**
 * Silent-turn recovery.
 *
 * A turn can end having delivered nothing: empty final text, or a body that
 * was entirely <internal> and stripped away. For a task or system trigger
 * that is often correct — delivered by email, posted mid-turn, or a reconnect
 * ack needing no action. For a human chat message it is a dropped reply, and
 * the user is left staring at silence with no way to tell the message
 * arrived; the observed workaround was typing "?" to shake it loose.
 *
 * This nudge composes with upstream's two rather than duplicating them:
 * the wrap-nudge fires when unwrapped content EXISTS and needs re-sending,
 * this one when nothing exists at all. The gating assertions below are the
 * important half — a nudge that fires on background work would turn every
 * silent-by-design task into chatter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

const CHAT_ROUTING = {
  platformId: 'C1',
  channelType: 'slack',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
  expectsReply: true,
};

/** A task batch: silent by design, and must never be nudged. */
const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
  expectsReply: false,
};

/** A system/on-wake batch: no human waiting, so also never nudged. */
const SYSTEM_ROUTING = { ...CHAT_ROUTING, expectsReply: false };

function queryYielding(...events: ProviderEvent[]): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* gen(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    for (const e of events) yield e;
  }
  return { pushes, query: { push: (m: string) => pushes.push(m), end: () => {}, events: gen(), abort: () => {} } };
}

const nudges = (pushes: string[]) => pushes.filter((p) => p.includes('Delivery check'));

function seedDestination(name: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', 'slack', 'C1', NULL)`,
    )
    .run(name, name);
}

beforeEach(() => {
  initTestSessionDb();
  seedDestination('general');
});
afterEach(() => closeSessionDb());

describe('silent-turn nudge', () => {
  it('fires when a chat turn delivers nothing', async () => {
    const { query, pushes } = queryYielding({ type: 'result', text: '' });
    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(1);
    expect(pushes[0]).toContain('EMPTY');
  });

  it('fires when the body was entirely <internal>', async () => {
    const { query, pushes } = queryYielding({ type: 'result', text: '<internal>just thinking</internal>' });
    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('does NOT fire for a task run that completes silently', async () => {
    const { query, pushes } = queryYielding({ type: 'result', text: '' });
    await processQuery(query, TASK_ROUTING, ['t1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(0);
  });

  it('does NOT fire for a system/on-wake turn', async () => {
    const { query, pushes } = queryYielding({ type: 'result', text: '' });
    await processQuery(query, SYSTEM_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(0);
  });

  it('does NOT fire when the turn actually delivered a message', async () => {
    const { query, pushes } = queryYielding({
      type: 'result',
      text: '<message to="general">here you go</message>',
    });
    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(0);
    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(1);
  });

  it('defers to the wrap-nudge when unwrapped content exists', async () => {
    // Unwrapped prose is a different failure with its own corrective retry;
    // stacking both would coax twice for one turn.
    const { query, pushes } = queryYielding({ type: 'result', text: 'bare prose, no message block' });
    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(0);
    expect(pushes.filter((p) => p.includes('not wrapped'))).toHaveLength(1);
  });

  it('does NOT fire on a provider failure — the error notice already speaks', async () => {
    const { query, pushes } = queryYielding({ type: 'result', text: '', isError: true });
    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(0);
  });

  it('nudges at most once per turn, even across two silent results', async () => {
    const { query, pushes } = queryYielding(
      { type: 'result', text: '' },
      { type: 'result', text: '' },
    );
    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    expect(nudges(pushes)).toHaveLength(1);
  });
});
