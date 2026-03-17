---
date: 2026-03-17
tags: [ops, feature, decision]
---

# Afternoon Activity — Mar 17

## Summary

Several configuration and infrastructure changes across groups, plus a bug discovered in Slack notification behaviour.

---

## 1. Job Search Channel Setup

Created and configured a new `#job-search` Slack channel (`slack:C0AM7DWV1U4`) as a dedicated space for automated job searching.

### What was done
- Registered the channel with folder `slack_job-search`, trigger `@agent`, `requiresTrigger: false`
- Created 7 criteria files in `groups/slack_job-search/`:
  - `01-role.md`, `02-location.md`, `03-compensation.md`, `04-technical.md`, `05-company.md`, `06-schedule.md`, `07-job-boards.md`
- Created `CLAUDE.md` for the job-search agent explaining its purpose, criteria file structure, and report format
- Added a mount for `slack_job-search` to the main group's `containerConfig` so the main agent can write to it

### Planned workflow
- Nightly: agent searches job boards based on criteria files
- Morning: agent posts a curated report of top matches to `#job-search`
- Status: awaiting John to fill in the criteria files before scheduled task is created

---

## 2. Agent Renamed: `@Andy` → `@agent`

Globally renamed the trigger from `@Andy` to `@agent` across all registered groups.

### Before
| Group | Trigger |
|-------|---------|
| main-group | `@Andy` |
| git-maintenance | `@robot` |
| others | `@agent` (already) |

### After
All groups use `@agent`.

---

## 3. requiresTrigger: false Made Default

All existing channels already had `requiresTrigger: false`. Preference recorded in `groups/main/memory.md` so all future channel registrations default to this. Source code default (`src/ipc.ts`) is still `true` — a code-level fix (defaulting to `false`) is tracked as a future improvement.

---

## 4. Container Session Behaviour — Discovery

Discovered that the NanoClaw container is **not restarted between messages** within a conversation. The host keeps stdin open and pipes new messages to the same running container. A new container is only spawned when the previous one exits (i.e. after a gap in activity or a service restart).

This has implications for mount config changes: adding a new volume mount via IPC only takes effect after the current container exits and a new one starts.

---

## 5. Slack Unread Notification Bug

### Problem
Messages posted by the agent don't trigger the channel unread (bold) indicator in Slack, even with channel notifications set to "All messages".

### Root cause
NanoClaw posts using `SLACK_BOT_TOKEN` (`xoxb-`). Slack treats bot-user messages differently — they don't reliably trigger the unread indicator regardless of notification settings.

### Proposed fix
Add optional `SLACK_USER_TOKEN` (`xoxp-`) support. When present, use it for `chat.postMessage` calls. Messages posted with a user token appear as a real Slack user and trigger normal notifications. Bot token should remain for non-message API calls (typing indicators, reactions, deletion).

Relevant file: `src/channels/slack.ts` — token init (~lines 51–64) and all `chat.postMessage` calls (~lines 253, 269, 272, 318, 349).

A terminal-based Claude Code session was started to implement this fix.
