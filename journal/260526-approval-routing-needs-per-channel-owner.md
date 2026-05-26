# 2026-05-26 — Approval cards need a per-channel owner identity

## The symptom

Inside a Slack thread, an agent requested admin approval to install the Playwright MCP server. The approval card was delivered to **WhatsApp** instead of Slack, even though the conversation that triggered it was happening in Slack. Annoying — context-switch out of the channel where the work was happening, just to tap Approve.

## Root cause

Approval routing is two steps (`src/modules/approvals/primitive.ts`):

1. `pickApprover(agent_group_id)` walks `user_roles` and returns user ids ordered as: scoped admins → global admins → owners.
2. `pickApprovalDelivery(approvers, originChannelType)` first tries to find an approver whose user-id namespace matches the origin channel (Slack → look for a `slack:` approver). Falls back to the first reachable approver if none match.

The DB had exactly one role row: `whatsapp:31683775990@s.whatsapp.net` → `owner`. My Slack user identity (`slack:U0AMGE1SNGY`) existed in `users` but **had no role grant**. So:

- The "prefer same channel as origin" loop skipped everything (no `slack:`-namespaced approvers).
- The fallback loop picked the only available approver — the WhatsApp one — and delivered there.

The router did exactly what it's designed to do. There was simply no Slack-side approver to choose.

## Fix

```bash
pnpm exec ncl roles grant --user slack:U0AMGE1SNGY --role owner
```

Now there are two global owners — one per channel identity. From a Slack-originated session, `pickApprovalDelivery` will hit the channel-match branch, call `ensureUserDm('slack:U0AMGE1SNGY')` (one-time `conversations.open` round trip to mint the DM, then cached in `user_dms`), and deliver to my Slack DM. WhatsApp-originated sessions still go to WhatsApp.

No restart needed — the host re-reads `user_roles` per approval request.

## The non-obvious bit

**NanoClaw has no concept of "same human across channels".** A user identity is `<channel>:<handle>`, and role grants are per-identity. If you want approvals to follow the channel where the request originated, you need an owner (or admin) grant for every channel identity you actually use.

The CLI even hints at this in `ncl roles help`:

> Approval routing prefers admins/owners reachable on the same messaging platform as the request origin.

But the converse isn't spelled out: *if you only have an owner on one channel, every approval lands there regardless of origin.* Worth keeping in mind whenever a new channel gets wired up.

## Why not just one owner

Considered revoking the WhatsApp owner since the Slack one would now handle Slack-originated work. Decided against it — owner identity is per-channel, so if Slack auth ever drifts (token expired, workspace re-init, OAuth revoked), the only owner would be unreachable and admin commands would lock out. Cheap to keep both; expensive to recover from losing the only one.

## Files touched

None. Single row inserted into `user_roles` via `ncl`. Central DB state only.

## Related

- `journal/260526-slack-session-consolidation-and-task-externalization.md` — earlier Slack routing work
- `src/modules/approvals/primitive.ts:103` — `pickApprovalDelivery` channel-match logic
- `src/modules/permissions/user-dm.ts:52` — `ensureUserDm` cold-resolve via `openDM`
