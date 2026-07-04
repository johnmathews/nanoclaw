/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMessage, editMessage } from './core.js';
import { queryReactions } from './reactions.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — <internal> stripping', () => {
  it('strips <internal> blocks from the delivered body', async () => {
    await sendMessage.handler({ to: 'peer', text: 'Done.<internal>secret reasoning</internal>' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Done.');
  });

  it('sends nothing when the body is entirely <internal>', async () => {
    const result = await sendMessage.handler({
      to: 'peer',
      text: '<internal>Report sent successfully via email. No Slack message needed.</internal>',
    });

    // Nothing written to the outbound queue.
    expect(getUndeliveredMessages()).toHaveLength(0);
    // And the tool reports back without erroring, so the agent doesn't retry.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Nothing sent');
  });
});

describe('edit_message MCP tool — <internal> stripping', () => {
  beforeEach(() => {
    // Seed an inbound message to target by seq (getMessageIdBySeq / getRoutingBySeq read this).
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('orig-msg', 5, 'chat', datetime('now'), 'done', 'chan-1', 'discord', '{}')`,
      )
      .run();
  });

  it('strips <internal> blocks from the edited body', async () => {
    await editMessage.handler({ messageId: 5, text: 'Corrected.<internal>why I changed it</internal>' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const content = JSON.parse(out[0].content);
    expect(content.operation).toBe('edit');
    expect(content.text).toBe('Corrected.');
  });

  it('skips the edit when the new body is entirely <internal>', async () => {
    const result = await editMessage.handler({
      messageId: 5,
      text: '<internal>nothing user-facing to say here</internal>',
    });

    // No edit queued — refuse rather than blank the message.
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Nothing edited');
  });
});

function insertReactionRow(
  id: string,
  timestamp: string,
  reaction: { emoji: string; rawEmoji: string; added: boolean; targetMessageId: string; userId: string },
  sender: string = 'John',
): void {
  const content = JSON.stringify({
    text: `[${sender} reacted ${reaction.emoji} on message ${reaction.targetMessageId}]`,
    sender,
    senderId: reaction.userId,
    reaction,
  });
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'chat-sdk', ?, 'pending', ?)`,
    )
    .run(id, timestamp, content);
}

describe('query_reactions MCP tool', () => {
  it('returns "no reactions" when the session has none', async () => {
    const result = await queryReactions.handler({});
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('No reactions');
  });

  it('lists all reactions in the session when no filter is given', async () => {
    insertReactionRow('rxn-1', '2026-05-22T10:00:00Z', {
      emoji: '👍',
      rawEmoji: '+1',
      added: true,
      targetMessageId: 'ts-1',
      userId: 'U1',
    });
    insertReactionRow('rxn-2', '2026-05-22T11:00:00Z', {
      emoji: '❤️',
      rawEmoji: 'heart',
      added: true,
      targetMessageId: 'ts-2',
      userId: 'U2',
    });
    const result = await queryReactions.handler({});
    const text = result.content[0].text as string;
    expect(text).toContain('"count": 2');
    expect(text).toContain('"emoji": "👍"');
    expect(text).toContain('"emoji": "❤️"');
  });

  it('filters by target_message_id', async () => {
    insertReactionRow('rxn-1', '2026-05-22T10:00:00Z', {
      emoji: '👍',
      rawEmoji: '+1',
      added: true,
      targetMessageId: 'ts-A',
      userId: 'U1',
    });
    insertReactionRow('rxn-2', '2026-05-22T11:00:00Z', {
      emoji: '❤️',
      rawEmoji: 'heart',
      added: true,
      targetMessageId: 'ts-B',
      userId: 'U2',
    });
    const result = await queryReactions.handler({ target_message_id: 'ts-A' });
    const text = result.content[0].text as string;
    expect(text).toContain('"count": 1');
    expect(text).toContain('ts-A');
    expect(text).not.toContain('ts-B');
  });

  it('preserves added=false (reaction removals)', async () => {
    insertReactionRow('rxn-1', '2026-05-22T10:00:00Z', {
      emoji: '👍',
      rawEmoji: '+1',
      added: false,
      targetMessageId: 'ts-1',
      userId: 'U1',
    });
    const result = await queryReactions.handler({});
    const text = result.content[0].text as string;
    expect(text).toContain('"added": false');
  });

  it('honors limit (orders newest-first)', async () => {
    for (let i = 0; i < 5; i++) {
      const ts = `2026-05-22T10:0${i}:00Z`;
      insertReactionRow(`rxn-${i}`, ts, {
        emoji: '⭐',
        rawEmoji: 'star',
        added: true,
        targetMessageId: `ts-${i}`,
        userId: 'U1',
      });
    }
    const result = await queryReactions.handler({ limit: 2 });
    const text = result.content[0].text as string;
    expect(text).toContain('"count": 2');
    // newest first: ts-4 and ts-3
    expect(text).toContain('ts-4');
    expect(text).toContain('ts-3');
    expect(text).not.toContain('ts-0');
  });

  it('ignores non-reaction chat-sdk rows', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES (?, 'chat-sdk', ?, 'pending', ?)`,
      )
      .run('plain-1', '2026-05-22T09:00:00Z', JSON.stringify({ text: 'hi', sender: 'Alice' }));
    const result = await queryReactions.handler({});
    expect(result.content[0].text).toContain('No reactions');
  });
});
