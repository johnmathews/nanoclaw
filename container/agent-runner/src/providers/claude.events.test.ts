/**
 * Regression coverage for ClaudeProvider's SDK-message → ProviderEvent mapping.
 *
 * Focus: `@anthropic-ai/claude-agent-sdk` 0.3.x ships rate limits as a
 * top-level `SDKRateLimitEvent` (`{ type: 'rate_limit_event' }`), NOT as a
 * `system` message with `subtype: 'rate_limit_event'`. The provider used to
 * match the old shape, so the branch was dead and quota signals were dropped
 * entirely. These tests lock in the top-level match.
 *
 * The SDK is stubbed so the mapping can be driven deterministically — no real
 * model call, no timers, no flakiness.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

let sdkMessages: Array<Record<string, unknown>> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');

async function collectEvents(): Promise<Array<{ type: string; [k: string]: unknown }>> {
  const provider = new ClaudeProvider();
  const out: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of provider.query({ prompt: 'hi', cwd: '/tmp' }).events) {
    out.push(e as { type: string; [k: string]: unknown });
  }
  return out;
}

describe('ClaudeProvider — SDK event mapping', () => {
  beforeEach(() => {
    sdkMessages = [];
  });

  it('maps a top-level rate_limit_event to a non-retryable quota error', async () => {
    sdkMessages = [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'rate_limit_event' }, // SDKRateLimitEvent — no `system` subtype
      { type: 'result', subtype: 'success', result: 'done' },
    ];

    const events = await collectEvents();
    const err = events.find((e) => e.type === 'error');

    expect(err).toBeDefined();
    expect(err).toMatchObject({
      type: 'error',
      message: 'Rate limit',
      retryable: false,
      classification: 'quota',
    });
  });

  it('does not treat the legacy system-subtype shape as a rate limit (guards the fix)', async () => {
    // The shape the SDK no longer sends; the old dead branch matched this.
    sdkMessages = [
      { type: 'system', subtype: 'init', session_id: 's2' },
      { type: 'system', subtype: 'rate_limit_event' },
      { type: 'result', subtype: 'success', result: 'done' },
    ];

    const events = await collectEvents();

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    // The turn still completes normally.
    expect(events.find((e) => e.type === 'result')).toMatchObject({ type: 'result', text: 'done' });
  });
});
