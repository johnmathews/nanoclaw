# Slack inbound restoration — path decision (W4.0)

**Status:** closed 2026-05-22; archived 2026-05-28. Path A (Events API + Tailscale Funnel) was decided and implemented; outcome and operational details in [../v2-migration/p3-notes.md §9](../v2-migration/p3-notes.md).

**Date:** 2026-05-22
**Original status (preserved for context):** Decided — **Path A (reconfigure existing Slack app from Socket Mode → Events API; Tailscale Funnel for ingress).**
**Context:** [p3-notes.md](p3-notes.md) §3.2 — v2's `@chat-adapter/slack` is webhook-only; v1's `@slack/bolt` was Socket Mode. The existing Slack app remains configured for Socket Mode, so Slack has nowhere to POST events, so v2 receives zero inbound events. Slack outbound (`chat.postMessage`) is unaffected and continues to work for scheduled tasks.

---

## 1. Paths considered

### Path A — Reconfigure the existing Slack app from Socket Mode → Events API

Stand up a public tunnel for `:3000/webhook/slack`. Disable Socket Mode in the existing Slack app dashboard, enable Event Subscriptions, point Request URL at the tunnel host, re-subscribe to the events v1 consumed plus any new ones v2 wants (e.g., `assistant_thread_started` for native typing).

### Path B — Custom Socket Mode adapter port

Port v1's `@slack/bolt` + `socketMode: true` shape onto v2's channel-registry contract. No public URL needed. `SLACK_APP_TOKEN` is already in v2's `.env`, so no new secrets.

### Path C — Fresh Slack app, configured Events-API-first from scratch

Create a new Slack app from the v2-canonical manifest. Still requires the same tunnel as Path A. New bot user; re-install in all 9 Slack channels. Old v1 app stays as a rollback safety net.

---

## 2. Decision rationale

**Picked Path A.** End-state architecture is identical to Path C; operational cost is lower than C; preserves v2-canonical adapter (no fork-local divergence, unlike B).

### Why not Path B

- "No public ingress" is partly illusory. Slack's signing-secret HMAC at the webhook is the same trust boundary as Socket Mode's xapp-token. Tailscale Funnel ingress + HMAC ≈ Socket Mode trust model in practice.
- Path B writes a custom adapter on top of v2's channel-registry contract, diverging further from upstream. Every `pnpm update @chat-adapter/slack` + every upstream-sync requires re-validating the fork's adapter against upstream's. Ongoing maintenance burden.
- Optimises for the wrong axis: "avoid this one piece of infra" at the cost of permanent code divergence.

### Why not Path C

- Feature parity is **independent of path choice** (see §3 audit below). Both A and C use the same `@chat-adapter/slack` package and the same `chat-sdk-bridge.ts` consumer. Same feature surface.
- Operational cost over A: new bot identity → re-invite in 9 Slack channels (private ones need explicit `/invite`); two bots with similar names coexist until the old one is removed (easy to `@mention` the wrong one for weeks); any DB rows or per-group CLAUDE.md references to bot user ID `U0AMHR1U9L0` need updating.
- C's *only* genuine gain over A: "the v1 app feels symbolically tainted; I want a fresh identity." That's a taste preference, not a robustness gain.
- Rollback advantage is also illusory: rolling back to v1-the-service is independent of which Slack app exists. v1 would still re-point at the Socket Mode config on whichever app it was using.

### Why Path A specifically

- Existing bot identity (`U0AMHR1U9L0`) and 9-channel memberships preserved with zero operator work.
- OAuth scopes are identical between Socket Mode and Events API — flipping transport does not require re-installing the app or re-granting scopes. The bot's permissions stay exactly as they were.
- Slack-app reconfiguration is contained to the api.slack.com dashboard; reversible with two clicks if anything goes wrong.
- Tailscale Funnel runs in the `tailscaled` daemon — survives SSH disconnect AND reboot (no extra systemd unit). Public URL: `https://agent.flicker-enigmatic.ts.net/webhook/slack`.

---

## 3. Parity audit — Path A and Path C are feature-identical

This audit decoupled the path decision from the feature-parity question. All of these are gated by `chat-sdk-bridge.ts` (consumer) and `@chat-adapter/slack` (adapter), not by which Slack app supplies events.

| Feature | v1 state | v2 adapter | Path-decision impact |
|---|---|---|---|
| Threads | ✅ working (thread_ts captured + replied in-thread; migration v6) | ✅ first-class API; `supportsThreads: true` already set in v2's `src/channels/slack.ts:21` | None — same under A and C |
| `:eyes:` thinking indicator | ✅ via status-tracker's `reactions.add` | ✅ `addReaction/removeReaction` + native `startTyping(threadId, status?)` (needs `assistant:write` scope) | None |
| Image inbound (multimodal) | ✅ download + base64 multimodal | Adapter exposes `files[]` w/ mimetype, url_private, dimensions. Consumer wiring in `chat-sdk-bridge.ts` is a separate audit. | None |
| Voice inbound (Whisper) | ✅ working | Same as image — adapter exposes file metadata; consumer wiring TBD | None |
| PDF/doc inbound | ✅ working | Same | None |
| Inbound `reaction_added` events | ❌ not handled | ✅ adapter dispatches `SlackReactionEvent` | None (v2 *gains* this either path) |
| Streaming outbound | ❌ not in v1 | ✅ `stream(threadId, textStream)` | None (v2 *gains* this either path) |
| Files outbound | ❌ not in v1 | ✅ via `AdapterPostableMessage` + private `uploadFiles` | None |

**The follow-up audit ("are files/reactions/typing/streaming actually wired through `chat-sdk-bridge.ts` end-to-end in v2?") is a separate W4.x work unit; it has the same effort under any path.** Out of scope for W4.0.

---

## 4. Out of scope for W4.0

- Slack **interactivity / block_actions** — v1's `app.action(/^nanoclaw_checkbox_/)` and `app.action(/^nanoclaw_confirm_/)` for the git-maintenance branch-delete confirm flow are not part of W4.0. v2's adapter does parse interactivity payloads at `/webhook/slack`, but whether `chat-sdk-bridge.ts` surfaces them to channel consumers is unverified. The next Mon/Thu 02:03 git-maintenance cron will post a checkbox message that the operator cannot confirm via Slack until this is ported. Tracked as a follow-up in p3-notes §9.
- **chat-sdk-bridge file/reaction/typing audit** — separate W4.x work unit.
- W4.3 health/watchdog, W4.4 mount-security audit, W4.5 `/usage` port, W4.6 remote-control, W4.7 journal MCP confirm.
- Gmail-as-channel (separate from Gmail MCP which is already wired).

---

## 5. Implementation plan

### 5.1 Tunnel setup (Tailscale Funnel)

Pre-flight: verify Funnel is enabled for this node on the tailnet ACL (one-time, requires tailnet admin). Then:

```bash
tailscale funnel --bg 3000
tailscale funnel status   # confirm https://agent.flicker-enigmatic.ts.net/ → 127.0.0.1:3000
```

Funnel survives SSH disconnect (daemon-level) and reboot (tailscaled autostart). Reset with `tailscale funnel reset` if needed.

### 5.2 Slack app dashboard changes (operator does these)

App URL: `https://api.slack.com/apps/<app_id>/`. Operator walks through clicks; this session does not touch the dashboard directly.

1. **Socket Mode** → Disable Socket Mode (turns off the WebSocket connection from Slack).
2. **Event Subscriptions** → Enable; set Request URL to `https://agent.flicker-enigmatic.ts.net/webhook/slack`. Slack verifies via signed POST; v2's adapter should respond to the `url_verification` challenge automatically.
3. **Event Subscriptions → Subscribe to bot events** — add (if not already present):
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
   - `member_joined_channel`
   - `assistant_thread_started` (only if `assistant:write` scope present)
   - `assistant_thread_context_changed` (same condition)
4. **Interactivity & Shortcuts** → Enable; Request URL: same as Event Subscriptions URL. (For future block_actions porting; not strictly needed for W4.0 message inbound.)
5. **OAuth & Permissions** → confirm scopes. v2's manifest expects: `app_mentions:read, channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, mpim:history, mpim:read, reactions:read, reactions:write, users:read`. Optionally add `assistant:write` for native typing. Reinstall to workspace only if a new scope is added.
6. **Save** at each panel.

### 5.3 Verification

```bash
# 1. Tunnel reachable
curl -sS https://agent.flicker-enigmatic.ts.net/webhook/slack -X POST \
  -d '{"type":"url_verification","challenge":"test"}' \
  -H "Content-Type: application/json" -o /dev/null -w '%{http_code}\n'
# Expected: 401 on unsigned (signing-secret HMAC enforced). The actual url_verification
# from Slack carries a valid signature and will return 200 with the challenge echoed.

# 2. Send a real Slack message — any channel v2 is wired to
# Then tail v2's log:
journalctl --user -u nanoclaw-v2-787facac.service --since "2 minutes ago" --no-pager \
  | grep -iE "slack|message routed|spawning|webhook"
# Expected: "Message routed … channelType: slack" + "Spawning container" + outbound reply lands

# 3. v2 service still healthy
systemctl --user is-active nanoclaw-v2-787facac.service
```

### 5.4 Rollback

If anything breaks:

1. At api.slack.com dashboard: re-enable Socket Mode; disable Event Subscriptions. Slack inbound returns to its pre-W4.0 state (broken on v2 — but Slack-app config is back to a known shape compatible with v1).
2. `tailscale funnel reset` to remove the public ingress.
3. v2 service unaffected; no code rollback needed (no code changes in W4.0).

---

## 6. Risks accepted

- **Public ingress exists.** Tailscale Funnel exposes port 3000 → world via `*.ts.net`. Mitigation: Slack signing-secret HMAC verification on every inbound request (v2's adapter rejects unsigned/mis-signed requests with 401). No application-layer attack surface beyond what the webhook verifies.
- **Tailscale Funnel availability.** If the tailnet's Funnel ACL is disabled, the tunnel cannot stand up — falls back to deciding A-with-different-tunnel (cloudflared/ngrok) or B. Pre-flight in §5.1 catches this.
- **Slack interactivity (checkboxes) still broken.** Out-of-W4.0-scope; tracked. Next Mon/Thu 02:03 git-maintenance cron will be the first manifestation.

---

## 7. Follow-up work units (after W4.0 lands)

- Audit `chat-sdk-bridge.ts` for files/reactions/typing/streaming wiring through to the agent pipeline.
- Port v1's interactivity handlers (`nanoclaw_checkbox_*`, `nanoclaw_confirm_*`) to v2's channel-registry contract.
- Consider whether `assistant:write` scope + `startTyping` should replace status-tracker's emoji-based progress indicator on Slack specifically.
