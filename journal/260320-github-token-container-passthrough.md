# Pass GitHub PAT into containers for git push

The `git-maintenance` Slack channel needed to push to remote, but containerised agents
can't read `.env` (it's shadowed with `/dev/null` for security).

## Changes

- **`src/container-runner.ts`**: Pass `GITHUB_TOKEN` into containers as an env var,
  same pattern as `PARALLEL_API_KEY`. Also switched both to use `readEnvFile()` instead
  of `process.env` — the app intentionally keeps `.env` values out of `process.env` to
  prevent secret leakage to child processes, so `process.env.PARALLEL_API_KEY` was
  silently never set.

- **`src/env.ts`**: `readEnvFile()` now distinguishes EACCES (permission denied) from
  ENOENT (file not found). Previously both were swallowed as a debug-level "not found"
  message, which caused a silent total failure when `.env` ownership changed to root.

- **`groups/slack_git-maintenance/CLAUDE.md`**: Removed "Do NOT push" safety rule,
  added "Remote Push" section with token-based auth instructions and guardrails
  (no force-push, user confirmation required).

## Incident: Slack stopped receiving messages after restart

Editing `.env` as root changed ownership to `root:root 600`, making it unreadable by
the service (runs as john). The previous process had already loaded tokens so it kept
working — but after `systemctl restart`, the new process couldn't read `.env`. Slack
tokens weren't loaded, so the channel never connected, and all messages were dropped
with `No channel owns JID, skipping messages`.

Fix: `sudo chown john:john .env` + the EACCES error logging so this is immediately
obvious if it happens again.
