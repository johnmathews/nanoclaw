/**
 * query_reactions.
 *
 * Reactions arrive as ordinary chat-sdk rows with a `reaction` object in their
 * content JSON, so the tool's job is parsing and filtering — and tolerating
 * rows that look nothing like a reaction, since the LIKE query that finds them
 * matches on serialized text rather than a column.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { queryReactions } from './reactions.js';

let seq = 0;

function seedReaction(opts: {
  id: string;
  target: string;
  emoji?: string;
  added?: boolean;
  sender?: string;
  userId?: string;
  timestamp?: string;
}): void {
  seq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
       VALUES (?, ?, 'chat-sdk', ?, 'completed', ?)`,
    )
    .run(
      opts.id,
      seq,
      opts.timestamp ?? '2026-11-05T09:00:00.000Z',
      JSON.stringify({
        text: `[${opts.sender ?? 'John'} reacted]`,
        sender: opts.sender ?? 'John',
        reaction: {
          emoji: opts.emoji ?? ':tada:',
          rawEmoji: (opts.emoji ?? ':tada:').replace(/:/g, ''),
          added: opts.added ?? true,
          targetMessageId: opts.target,
          userId: opts.userId ?? 'U1',
        },
      }),
    );
}

/** A chat-sdk row that is not a reaction, to prove the filter holds. */
function seedPlain(id: string, content: string): void {
  seq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
       VALUES (?, ?, 'chat-sdk', '2026-11-05T09:00:00.000Z', 'completed', ?)`,
    )
    .run(id, seq, content);
}

function parse(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0].text) as { count: number; reactions: Array<Record<string, unknown>> };
}

beforeEach(() => {
  seq = 0;
  initTestSessionDb();
});
afterEach(() => closeSessionDb());

describe('query_reactions', () => {
  it('reports plainly when there are none', async () => {
    const res = await queryReactions.handler({});
    expect(String(res.content[0].text)).toContain('No reactions recorded');
  });

  it('returns the structured reaction payload', async () => {
    seedReaction({ id: 'r-1', target: 'm-1', emoji: ':tada:' });
    const out = parse((await queryReactions.handler({})) as never);
    expect(out.count).toBe(1);
    expect(out.reactions[0]).toMatchObject({
      emoji: ':tada:',
      rawEmoji: 'tada',
      added: true,
      targetMessageId: 'm-1',
      userId: 'U1',
      userName: 'John',
    });
  });

  it('filters to one target message', async () => {
    seedReaction({ id: 'r-1', target: 'm-1' });
    seedReaction({ id: 'r-2', target: 'm-2' });
    const out = parse((await queryReactions.handler({ target_message_id: 'm-2' })) as never);
    expect(out.count).toBe(1);
    expect(out.reactions[0].targetMessageId).toBe('m-2');
  });

  it('says so when the filter matches nothing', async () => {
    seedReaction({ id: 'r-1', target: 'm-1' });
    const res = await queryReactions.handler({ target_message_id: 'm-999' });
    expect(String(res.content[0].text)).toContain('No reactions recorded for message m-999');
  });

  it('preserves a removal rather than folding it away', async () => {
    // An add then a remove of the same emoji is a net-zero; collapsing it here
    // would invent state the platform never reported.
    seedReaction({ id: 'r-1', target: 'm-1', emoji: ':eyes:', added: true });
    seedReaction({ id: 'r-2', target: 'm-1', emoji: ':eyes:', added: false });
    const out = parse((await queryReactions.handler({})) as never);
    expect(out.count).toBe(2);
    expect(out.reactions.map((r) => r.added).sort()).toEqual([false, true]);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) seedReaction({ id: `r-${i}`, target: 'm-1' });
    expect(parse((await queryReactions.handler({ limit: 2 })) as never).count).toBe(2);
  });

  it('ignores rows that mention reaction but are not one, and malformed JSON', async () => {
    // Both reach the handler: the finder's LIKE matches serialized text.
    seedPlain('p-1', JSON.stringify({ text: 'talking about a "reaction": here', sender: 'John' }));
    seedPlain('p-2', '{"reaction": not json');
    const res = await queryReactions.handler({});
    expect(String(res.content[0].text)).toContain('No reactions recorded');
  });

  it('skips a reaction with no target message id', async () => {
    seedPlain('p-3', JSON.stringify({ sender: 'John', reaction: { emoji: ':x:', added: true } }));
    const res = await queryReactions.handler({});
    expect(String(res.content[0].text)).toContain('No reactions recorded');
  });
});
