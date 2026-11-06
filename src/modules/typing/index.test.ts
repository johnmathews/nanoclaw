/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import { clearWorkingMarker, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('working marker (fork: Slack 👀)', () => {
  type MarkerCall = {
    op: 'mark' | 'clear';
    platformId: string;
    threadId: string | null;
    messageId: string;
    instance?: string;
  };

  function markerAdapter() {
    const calls: MarkerCall[] = [];
    setTypingAdapter({
      async setTyping() {},
      async markWorking(_channelType, platformId, threadId, messageId, instance) {
        calls.push({ op: 'mark', platformId, threadId, messageId, instance });
      },
      async clearWorking(_channelType, platformId, threadId, messageId, instance) {
        calls.push({ op: 'clear', platformId, threadId, messageId, instance });
      },
    });
    return calls;
  }

  it('marks the inbound message once, not on every refresh tick', async () => {
    const calls = markerAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.1');
    await vi.advanceTimersByTimeAsync(12_000); // three ticks inside the grace window
    expect(calls).toEqual([
      { op: 'mark', platformId: 'slack:C1', threadId: null, messageId: '100.1', instance: undefined },
    ]);
  });

  it('clears on a delivered reply and never re-marks the same message', async () => {
    const calls = markerAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack', '100.1');
    await vi.advanceTimersByTimeAsync(0);
    clearWorkingMarker('sess-1');
    await vi.advanceTimersByTimeAsync(12_000); // refresher keeps ticking inside grace
    expect(calls.map((c) => `${c.op}:${c.messageId}`)).toEqual(['mark:100.1', 'clear:100.1']);
    expect(calls[1].instance).toBe('slack');
  });

  it('moves the marker to a newer inbound message', async () => {
    const calls = markerAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.1');
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.2');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => `${c.op}:${c.messageId}`)).toEqual(['mark:100.1', 'clear:100.1', 'mark:100.2']);
  });

  it('a new inbound after a delivered reply gets its own marker', async () => {
    const calls = markerAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.1');
    clearWorkingMarker('sess-1');
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.2');
    await vi.advanceTimersByTimeAsync(0);
    // 100.1 was already cleared, so moving on does not clear it twice.
    expect(calls.map((c) => `${c.op}:${c.messageId}`)).toEqual(['mark:100.1', 'clear:100.1', 'mark:100.2']);
  });

  it('clears when the refresher stops (container exit) without a reply', async () => {
    const calls = markerAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.1');
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => `${c.op}:${c.messageId}`)).toEqual(['mark:100.1', 'clear:100.1']);
  });

  it('clears when the agent goes idle (grace over, no heartbeat)', async () => {
    const calls = markerAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.1');
    await vi.advanceTimersByTimeAsync(20_000); // past the 15s grace; no heartbeat file in the test DATA_DIR
    expect(calls.map((c) => `${c.op}:${c.messageId}`)).toEqual(['mark:100.1', 'clear:100.1']);
  });

  it('does nothing without an inbound message id', async () => {
    const calls = markerAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null);
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
  });

  it('a failing marker call never throws into routing', async () => {
    setTypingAdapter({
      async markWorking() {
        throw new Error('missing_scope');
      },
      async clearWorking() {
        throw new Error('no_reaction');
      },
    });
    expect(() => startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, undefined, '100.1')).not.toThrow();
    expect(() => stopTypingRefresh('sess-1')).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});
