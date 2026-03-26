# Fix CI Race Condition and Pre-Commit Formatting

**Date:** 2026-03-26

## What

Diagnosed and fixed two CI failures on the fork:

1. **Prettier format check failing**: The `.husky/pre-commit` hook ran `prettier --write` to format files but
   didn't re-stage them. Git commits the staged snapshot, so the formatted-on-disk version was left behind and
   the committed version was unformatted. CI's `prettier --check` then failed.

2. **Bump version push rejected**: The `bump-version` and `update-tokens` workflows both trigger on push to main
   with overlapping path filters. Both commit and push. When they run concurrently, the second one gets
   "cannot lock ref" because the first already advanced the ref.

## Fixes

- Added `git update-index --again` to `.husky/pre-commit`. This re-stages any files already in the index that
  were modified by the formatter, so the commit includes the formatted version.

- Added `concurrency: { group: auto-commit-main, cancel-in-progress: false }` to both `bump-version.yml` and
  `update-tokens.yml`. They now queue instead of racing. `cancel-in-progress: false` ensures both run to
  completion rather than one cancelling the other.

## Also noted (not fixed)

The upstream `qwibitai/nanoclaw` repo's `label-pr.yml` uses `pull_request` trigger, which gives fork PRs
read-only tokens. The `addLabels` API call gets 403 on fork PRs. Fix would be switching to `pull_request_target`
(safe here since the workflow only reads event payload data, doesn't check out untrusted code).
