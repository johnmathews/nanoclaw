/**
 * Tests for the interactive MCP tools — focused on send_blocks, which is the
 * Slack-Block-Kit passthrough used by the git-maintenance Mon/Thu cron and
 * any other agent that needs Block Kit features the cross-platform Card
 * primitive can't express.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendBlocks } from './interactive.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a session_routing row so send_blocks resolves the default destination.
  // The in-memory test DB doesn't create the routing table by default — getSessionRouting
  // silently returns nulls then. send_blocks uses routing() directly (not the
  // destinations fallback), so we provide the table + row explicitly.
  const db = getInboundDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_routing (
      id INTEGER PRIMARY KEY,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT
    );
  `);
  db.prepare(
    `INSERT INTO session_routing (id, platform_id, channel_type, thread_id)
     VALUES (1, 'slack:C12345', 'slack', 'slack:C12345:1700000000.000100')`,
  ).run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_blocks MCP tool', () => {
  it('accepts an array of blocks and writes a typed outbound row', async () => {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Git Maintenance' } },
      {
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: 'Go' }, action_id: 'ncv2:confirm_delete' }],
      },
    ];
    const result = await sendBlocks.handler({ blocks, fallbackText: 'Git Maintenance report' });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat-sdk');
    expect(out[0].channel_type).toBe('slack');
    const parsed = JSON.parse(out[0].content);
    expect(parsed.type).toBe('blocks');
    expect(parsed.blocks).toEqual(blocks);
    expect(parsed.fallbackText).toBe('Git Maintenance report');
  });

  it('accepts a JSON string of blocks (Slack tool-args sometimes stringify)', async () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];
    const result = await sendBlocks.handler({
      blocks: JSON.stringify(blocks),
      fallbackText: 'hi',
    });
    expect(result.isError).toBeUndefined();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).blocks).toEqual(blocks);
  });

  it('rejects an empty fallbackText (load-bearing for non-Slack adapters)', async () => {
    const result = await sendBlocks.handler({
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' } }],
      fallbackText: '',
    });
    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects malformed JSON string for blocks', async () => {
    const result = await sendBlocks.handler({ blocks: '{not json', fallbackText: 'x' });
    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects a non-array, non-string blocks payload', async () => {
    const result = await sendBlocks.handler({ blocks: { not: 'an array' }, fallbackText: 'x' });
    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
