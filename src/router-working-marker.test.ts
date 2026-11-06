/**
 * Fork: which inbound message the Slack 👀 working marker goes on. A user's
 * reaction arrives as a synthetic chat-sdk row; it must not become the
 * marker target, or it would pull 👀 off the message the agent is answering.
 */
import { describe, expect, it } from 'vitest';

import type { InboundEvent } from './channels/adapter.js';
import { workingMarkerMessageId } from './router.js';

function event(id: string, content: unknown): InboundEvent {
  return {
    channelType: 'slack',
    platformId: 'slack:C1',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      content: typeof content === 'string' ? content : JSON.stringify(content),
      timestamp: '2026-11-07T00:00:00.000Z',
    },
  } as InboundEvent;
}

describe('workingMarkerMessageId', () => {
  it('uses the platform id of a real message', () => {
    expect(workingMarkerMessageId(event('1794003907.745989', { text: 'hi' }))).toBe('1794003907.745989');
  });

  it('yields no target for a reaction row', () => {
    const reaction = { text: '[John reacted 👍 on message 1.1]', reaction: { emoji: 'thumbsup', added: true } };
    expect(workingMarkerMessageId(event('rxn-1794003907-abc123', reaction))).toBeUndefined();
  });

  it('treats unparseable content as a real message', () => {
    expect(workingMarkerMessageId(event('1.2', 'not json'))).toBe('1.2');
  });

  it('yields no target for an empty id', () => {
    expect(workingMarkerMessageId(event('', { text: 'hi' }))).toBeUndefined();
  });
});
