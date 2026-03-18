---
date: 2026-03-17
tags: [feature]
---

# Add Job Search Slack Channel

Created and configured a new `#job-search` Slack channel (`slack:C0AM7DWV1U4`) as a dedicated space for automated job
searching.

## What was done

- Registered the channel with folder `slack_job-search`, trigger `@agent`, `requiresTrigger: false`
- Created 7 criteria files in `groups/slack_job-search/`:
  - `01-role.md`, `02-location.md`, `03-compensation.md`, `04-technical.md`, `05-company.md`, `06-schedule.md`,
    `07-job-boards.md`
- Created `CLAUDE.md` for the job-search agent explaining its purpose, criteria file structure, and report format
- Added a mount for `slack_job-search` to the main group's `containerConfig` so the main agent can write to it

## Planned workflow

- Nightly: agent searches job boards based on criteria files
- Morning: agent posts a curated report of top matches to `#job-search`
- Status: awaiting John to fill in the criteria files before scheduled task is created
