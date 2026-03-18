---
date: 2026-03-18
tags: [ops, feature]
---

# Git Maintenance Improvements

## What changed

The daily git maintenance agent (runs in the `group` workspace, not the nanoclaw
container) was extended with two improvements:

1. **Skill branch auto-update** — on each daily run, all local `skill/*` branches
   are fast-forwarded to their `origin/` counterparts. If a branch has diverged and
   can't be fast-forwarded, it's flagged in the report for review. Previously, skill
   branches silently drifted behind origin.

2. **Upstream GitHub activity in the daily report** — the *"What's new upstream"*
   section now includes issues and PRs from `qwibitai/nanoclaw` that had activity in
   the last 24 hours. Each item shows title, comment/reaction counts, and an
   engagement-rate marker (📈 / 🔥) that normalises activity by age — a 1h-old PR
   with 1 reaction scores higher than a 20h-old PR with the same. Age is not shown
   directly; it's enough to know the item was active in the last 24h.

## Why

Skill branches were falling behind without notice, making it easy to miss upstream
fixes. The GitHub activity feed gives visibility into community interest and new
features coming in the upstream fork without having to check GitHub manually.

## Implementation

The maintenance agent is configured via `groups/group/CLAUDE.md` (not in this repo).
It uses `curl` to call the GitHub API (no auth token — public repo) and posts the
report as a Slack Block Kit message with interactive checkboxes for branch deletion.

The engagement rate formula: `rate = (comments + reactions) / max(age_hours, 0.5)`.
Markers: 🔥 if rate ≥ 1.0, 📈 if rate ≥ 0.2.
