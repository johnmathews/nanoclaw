/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  getDeferredDeliveries,
  insertMessage,
  markDelivered,
  markDeliveryFailed,
  markDeliveryDeferred,
  migrateDeliveredTable,
} from './db/session-db.js';
import { log } from './log.js';
import { normalizeOptions } from './channels/ask-question.js';
import { classifyDeliveryError, ChannelDisconnectedError, PermanentDeliveryError } from './channels/delivery-errors.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from './session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Backoff before re-driving a message that's deferred because its channel is
 *  offline. Capped so a long outage doesn't stretch the gap indefinitely, but
 *  long enough to avoid hammering a reconnecting socket every poll tick. */
const DEFERRAL_BACKOFF_BASE_SEC = 15;
const DEFERRAL_BACKOFF_MAX_SEC = 120;

/** Track transient (channel-online) delivery attempt counts. Resets on process
 *  restart, which gives messages a fresh chance. Channel-offline deferrals are
 *  tracked in the `delivered` table instead (so they survive restarts). */
const deliveryAttempts = new Map<string, number>();

/** ISO timestamp `sec` seconds in the future — backoff gate for deferred rows. */
function backoffUntil(sec: number): string {
  return new Date(Date.now() + sec * 1000).toISOString();
}

function deferralBackoffSec(attempts: number): number {
  return Math.min(DEFERRAL_BACKOFF_MAX_SEC, DEFERRAL_BACKOFF_BASE_SEC * 2 ** Math.max(0, attempts - 1));
}

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

/**
 * Sessions with a non-terminal delivery (channel-offline deferral in backoff,
 * or a transient mid-retry) that must keep being re-driven on the fast 1s poll
 * even after their container goes idle/stopped.
 *
 * Without this, a session drops out of getRunningSessions() the moment its
 * agent's turn ends, so an undelivered reply waits for the 60s sweep — or, in
 * practice, until the user sends another message that re-wakes the container.
 * That was the "ask → silence → poke → reply appears instantly" regression.
 *
 * Entries are added/cleared by drainSession based on the session's actual
 * pending state, so a recovered (or deleted) session stops being polled.
 */
const pendingRedrive = new Map<string, Session>();

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    /** Delivering adapter instance (defaults to channelType downstream).
     *  Host-internal only — containers never see instance. */
    instance?: string,
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

/** Whether both delivery polls are currently enabled. Read by the health snapshot. */
export function getDeliveryPollsRunning(): boolean {
  return activePolling && sweepPolling;
}

/**
 * Re-drive delivery for every active session immediately.
 *
 * Wired to a channel adapter's `onReconnect` hook: the instant a reconnect-prone
 * transport (WhatsApp) re-opens its socket, any message that deferred during the
 * outage flushes now instead of waiting for the next poll tick or 60s sweep.
 * Fire-and-forget; the per-session inflight guard makes it safe to overlap with
 * the regular polls.
 */
export async function redriveActiveSessionsNow(): Promise<void> {
  try {
    for (const session of getActiveSessions()) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Channel-reconnect re-drive error', { err });
  }
}

/** Whether a session is currently being kept on the fast poll because it has a
 *  non-terminal delivery pending (deferred in backoff, or mid transient retry).
 *  Exposed for tests and health introspection. */
export function hasPendingRedrive(sessionId: string): boolean {
  return pendingRedrive.has(sessionId);
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    // Also drive sessions that still have a pending (deferred / mid-retry)
    // delivery even though their container is no longer running — see
    // pendingRedrive. Dedup against the running set so a session isn't drained
    // twice in one tick.
    const seen = new Set(sessions.map((s) => s.id));
    for (const session of pendingRedrive.values()) {
      if (!seen.has(session.id)) sessions.push(session);
    }
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    pendingRedrive.delete(session.id);
    return;
  }

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    pendingRedrive.delete(session.id);
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) {
      pendingRedrive.delete(session.id);
      return;
    }

    // Ensure delivery-tracking columns exist (migration for existing sessions).
    // Run before reading the table so the status/attempts queries don't trip on
    // a pre-migration schema.
    migrateDeliveredTable(inDb);

    // Filter out terminal messages (delivered or permanently failed). Deferred
    // messages stay in the set — they're re-driven once their backoff elapses.
    const delivered = getDeliveredIds(inDb);
    const deferred = getDeferredDeliveries(inDb);
    const nowIso = new Date().toISOString();
    const undelivered = allDue.filter((m) => {
      if (delivered.has(m.id)) return false;
      const d = deferred.get(m.id);
      if (d?.next_attempt_at && d.next_attempt_at > nowIso) return false; // backoff not elapsed
      return true;
    });

    // Track which messages reached a terminal state (delivered or permanently
    // failed) — by the end, anything in allDue NOT here is still pending
    // (deferred in backoff, or scheduled for a transient retry) and the session
    // must stay on the fast poll. Seed with the already-terminal set.
    const resolved = new Set<string>(delivered);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        resolved.add(msg.id);
        deliveryAttempts.delete(msg.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const disposition = classifyDeliveryError(err);

        // Channel offline — the message is fine, the pipe is down. Defer with
        // backoff and re-drive later; never count it against the retry budget
        // and never mark it terminal. This is the path that previously
        // returned undefined and got silently marked "delivered".
        if (disposition === 'disconnected') {
          const attempts = (deferred.get(msg.id)?.attempts ?? 0) + 1;
          markDeliveryDeferred(inDb, msg.id, attempts, backoffUntil(deferralBackoffSec(attempts)));
          log.warn('Message delivery deferred — channel offline, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            deferrals: attempts,
            err,
          });
          continue;
        }

        // Permanent — retrying can't help (bad scope, deleted target, ACL).
        // Give up immediately and tell the agent its message never landed.
        if (disposition === 'permanent') {
          log.error('Message delivery failed permanently (non-retryable), giving up', {
            messageId: msg.id,
            sessionId: session.id,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          resolved.add(msg.id);
          deliveryAttempts.delete(msg.id);
          surfaceDeliveryFailure(msg, inDb, err);
          continue;
        }

        // Transient (channel online, send errored) — bounded immediate retries.
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          resolved.add(msg.id);
          deliveryAttempts.delete(msg.id);
          surfaceDeliveryFailure(msg, inDb, err);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }

    // Keep the session on the fast poll iff something's still pending (deferred
    // in backoff, or scheduled for a transient retry); otherwise stop polling it
    // off-container so the set doesn't grow unbounded.
    const keepPending = allDue.some((m) => !resolved.has(m.id));
    if (keepPending) pendingRedrive.set(session.id, session);
    else pendingRedrive.delete(session.id);
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    // Not "drop" — the adapter may simply not be wired yet at boot. Treat as a
    // disconnected channel so the message is deferred and re-driven, not
    // silently marked delivered.
    throw new ChannelDisconnectedError(`No delivery adapter configured yet (message ${msg.id})`);
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channel_type === 'agent') {
    if (!hasTable(getDb(), 'agent_destinations')) {
      throw new PermanentDeliveryError(
        `agent-to-agent module not installed — cannot route message ${msg.id}`,
        'module_not_installed',
      );
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(msg, session);
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  let deliverInstance: string | undefined;
  // Per-channel reply mode override (set on the messaging_group). For
  // `'channel'`, we strip the inbound thread_id so the bridge falls back to
  // platform_id (channel root). Hoisted out of the destinations-ACL block
  // below so the override survives to the deliver() call.
  let effectiveThreadId = msg.thread_id;
  if (msg.channel_type && msg.platform_id) {
    // Resolve the messaging group ORIGIN-SESSION-FIRST: when the message
    // targets the session's own chat address, the origin row wins even if
    // sibling instances share the same (channel_type, platform_id) — so the
    // reply goes out through the instance the message came in on. Otherwise
    // fall back to the by-platform lookup (default-instance-first).
    const originMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channel_type && originMg.platform_id === msg.platform_id
        ? originMg
        : getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new PermanentDeliveryError(
        `unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`,
        'unknown_messaging_group',
      );
    }
    if (mg.reply_mode === 'channel') effectiveThreadId = null;
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
      const row = getDb()
        .prepare(
          'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        )
        .get(session.agent_group_id, 'channel', mg.id);
      if (!row) {
        throw new PermanentDeliveryError(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
          'unauthorized_destination',
        );
      }
    }
    deliverInstance = mg.instance;
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    effectiveThreadId,
    msg.kind,
    msg.content,
    files,
    deliverInstance,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  clearOutbox(session.agent_group_id, session.id, msg.id);

  return platformMsgId;
}

/**
 * Tell the agent that one of its outbound messages never reached the user.
 *
 * Without this, a terminally-failed send is invisible: the agent's own record
 * (its outbound DB row) makes it believe the message was sent, so it "remembers"
 * sending something the user never got. We write a context-only inbound row
 * (`trigger: 0`) into the session's inbound DB: it does NOT wake the container
 * on its own (so a broken channel can't spin a deliver→notify→deliver loop),
 * but it rides along on the agent's next real turn so it can re-send via another
 * route or tell the user. Best-effort: a failure to surface must never crash the
 * delivery loop, so this swallows its own errors.
 */
function surfaceDeliveryFailure(
  msg: { id: string; content: string; channel_type: string | null; platform_id: string | null },
  inDb: Database.Database,
  err: unknown,
): void {
  try {
    let preview = '';
    try {
      const parsed = JSON.parse(msg.content) as Record<string, unknown>;
      const body = (parsed.markdown as string) || (parsed.text as string) || '';
      preview = body.length > 200 ? `${body.slice(0, 200)}…` : body;
    } catch {
      /* non-JSON / opaque content — omit preview */
    }
    const reason =
      err instanceof PermanentDeliveryError && err.reason
        ? err.reason
        : err instanceof Error
          ? err.message
          : String(err);
    const dest = msg.channel_type
      ? `${msg.channel_type}${msg.platform_id ? `/${msg.platform_id}` : ''}`
      : 'the channel';
    const text =
      `⚠️ System notice: a message you sent could NOT be delivered to ${dest} and the user did not receive it ` +
      `(reason: ${reason}). If it still matters, re-send it (optionally via another route) or let the user know.` +
      (preview ? `\n\nUndelivered message:\n${preview}` : '');

    insertMessage(inDb, {
      id: `delivery-fail-${msg.id}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderName: 'System', system: true }),
      processAfter: null,
      recurrence: null,
      trigger: 0,
    });
  } catch (surfaceErr) {
    log.error('Failed to surface delivery failure to agent', { messageId: msg.id, err: surfaceErr });
  }
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}

/** Look up a registered delivery-action handler. Lets module registrations be behavior-tested. */
export function getDeliveryAction(action: string): DeliveryActionHandler | undefined {
  return actionHandlers.get(action);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }

  log.warn('Unknown system action', { action });
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
