/**
 * Delivery error taxonomy.
 *
 * The host's outbound delivery loop (src/delivery.ts) decides what to do with a
 * failed send based on which of these an adapter throws. The cardinal rule —
 * and the bug this taxonomy fixes — is that a *successful return* from
 * `deliver()` means the message reached the platform. An adapter that couldn't
 * actually send MUST throw, never return `undefined`; `undefined` is reserved
 * for operations that legitimately produce no platform message id (reactions,
 * edits, intentionally-skipped empties).
 *
 * Three failure dispositions:
 *
 *   - disconnected — the channel is offline *right now* (socket down, adapter
 *     not yet registered). The message was not sent and nothing is wrong with
 *     it. Re-driven indefinitely with backoff until the channel recovers; never
 *     counts against the retry budget and never marked terminally failed. This
 *     is the WhatsApp-reconnect case that previously returned undefined and got
 *     silently marked delivered.
 *
 *   - permanent — delivery can never succeed for this message as-is: bad OAuth
 *     scope, deleted edit/reaction target, unknown route, ACL rejection.
 *     Terminal immediately; surfaced to the agent; never retried (retrying just
 *     hammers the platform API).
 *
 *   - transient — anything else (network blip, 5xx, timeout). Retried a bounded
 *     number of times, then marked failed and surfaced.
 */

/** Channel offline — message not sent; retry later without burning the budget. */
export class ChannelDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelDisconnectedError';
  }
}

/** Delivery can never succeed as-is — terminal, surfaced, never retried. */
export class PermanentDeliveryError extends Error {
  /** Short machine-ish reason (e.g. the Slack error code) for surfacing/logging. */
  readonly reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
    this.reason = reason;
  }
}

/**
 * Known-permanent platform error fragments. Channel adapters surface platform
 * API errors as thrown `Error`s whose message embeds the platform's own code —
 * e.g. the Slack Web API throws `An API error occurred: missing_scope`. None of
 * these are fixed by retrying: the scope is missing, the channel is archived,
 * the target message is gone. Matched case-insensitively as substrings.
 */
const PERMANENT_PLATFORM_ERRORS = [
  // auth / permission
  'missing_scope',
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'no_permission',
  'restricted_action',
  'ekm_access_denied',
  // routing / target
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'message_not_found',
  'cant_update_message',
  'cant_delete_message',
  'thread_not_found',
  'user_not_found',
  'users_not_found',
  'cannot_dm_bot',
  // malformed payload (resending the same bytes won't help)
  'msg_too_long',
  'no_text',
  'invalid_blocks',
  'invalid_arguments',
];

/** Classify a thrown delivery error into a retry disposition. */
export function classifyDeliveryError(err: unknown): 'permanent' | 'disconnected' | 'transient' {
  if (err instanceof PermanentDeliveryError) return 'permanent';
  if (err instanceof ChannelDisconnectedError) return 'disconnected';
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (PERMANENT_PLATFORM_ERRORS.some((code) => msg.includes(code))) return 'permanent';
  return 'transient';
}
