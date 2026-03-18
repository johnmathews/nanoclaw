---
date: 2026-03-17
tags: [fix]
---

# Fix Slack Unread Notifications

## Problem

Messages posted by the agent don't trigger the channel unread (bold) indicator in Slack, even with channel notifications
set to "All messages".

## Root cause

NanoClaw posts using `SLACK_BOT_TOKEN` (`xoxb-`). Slack treats bot-user messages differently — they don't reliably
trigger the unread indicator regardless of notification settings.

## Fix

Added optional `SLACK_USER_TOKEN` (`xoxp-`) support. When present, it's used for `chat.postMessage` calls. Messages
posted with a user token appear as a real Slack user and trigger normal notifications. Bot token remains for non-message
API calls (typing indicators, reactions, deletion).

Relevant file: `src/channels/slack.ts` — token init (~lines 51–64) and all `chat.postMessage` calls.

## Resolution

Deployed and confirmed working at ~16:39 — Slack channels now go bold and show unread indicators when the agent posts.
