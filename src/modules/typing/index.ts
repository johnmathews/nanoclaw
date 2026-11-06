/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { log } from '../../log.js';
import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
  /**
   * Fork: per-message "working" marker (Slack: a 👀 reaction on the inbound
   * message). The adapter decides whether it applies — e.g. Slack only marks
   * in unthreaded chats, where its native thread status has nowhere to show.
   */
  markWorking?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    messageId: string,
    instance?: string,
  ): Promise<void>;
  clearWorking?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    messageId: string,
    instance?: string,
  ): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  /** Platform id of the inbound message that woke the agent (working-marker target). */
  messageId: string | null;
  /** Marker currently placed on messageId. */
  marked: boolean;
  /** Marker was cleared for messageId (reply delivered); never re-mark that message. */
  settled: boolean;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

type MarkerAddress = Pick<TypingTarget, 'channelType' | 'platformId' | 'threadId' | 'instance'>;

function logMarkerFailure(op: string, messageId: string, err: unknown): void {
  // Best-effort like typing, but not silent: a missing scope or a bad id
  // would otherwise leave the indicator dead with no trace.
  log.warn(`Working marker ${op} failed`, { messageId, err: err instanceof Error ? err.message : String(err) });
}

/** Place the working marker once per inbound message. */
function markIfNeeded(entry: TypingTarget): void {
  if (!entry.messageId || entry.marked || entry.settled || !adapter?.markWorking) return;
  entry.marked = true;
  const messageId = entry.messageId;
  adapter
    .markWorking(entry.channelType, entry.platformId, entry.threadId, messageId, entry.instance)
    .catch((err) => logMarkerFailure('add', messageId, err));
}

function clearMarker(addr: MarkerAddress, messageId: string | null, marked: boolean): void {
  if (!messageId || !marked || !adapter?.clearWorking) return;
  adapter
    .clearWorking(addr.channelType, addr.platformId, addr.threadId, messageId, addr.instance)
    .catch((err) => logMarkerFailure('remove', messageId, err));
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  messageId?: string,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // A new inbound message moves the working marker to it: clear the old
    // message's marker (at its own address) before the address changes.
    const nextMessageId = messageId ?? null;
    if (nextMessageId !== existing.messageId) {
      clearMarker({ ...existing }, existing.messageId, existing.marked);
      existing.messageId = nextMessageId;
      existing.marked = false;
      existing.settled = false;
    }
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    // Keep the stored entry self-consistent: a re-trigger can arrive from
    // a different chat address (agent-shared sessions span messaging
    // groups, possibly on different platforms/instances), so the address
    // fields and the owning instance must move together — a torn entry
    // (old address + new instance) would hand e.g. a telegram platformId
    // to a Slack instance's setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    markIfNeeded(existing);
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
      markIfNeeded(entry);
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
    clearMarker(entry, entry.messageId, entry.marked);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  const entry: TypingTarget = {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
    pausedUntil: 0,
    messageId: messageId ?? null,
    marked: false,
    settled: false,
  };
  typingRefreshers.set(sessionId, entry);
  markIfNeeded(entry);
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

/**
 * Clear the working marker because a reply reached the user. The refresher
 * keeps running (the agent may still be working), but the same inbound
 * message is never re-marked; the next inbound message gets a fresh marker.
 */
export function clearWorkingMarker(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearMarker(entry, entry.messageId, entry.marked);
  entry.marked = false;
  entry.settled = true;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
  clearMarker(entry, entry.messageId, entry.marked);
}
