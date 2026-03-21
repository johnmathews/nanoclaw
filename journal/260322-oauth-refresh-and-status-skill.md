# OAuth Token Auto-Refresh & Status Skill Improvements

**Date:** 2026-03-22

## OAuth Token Auto-Refresh

The `/usage` command fetches rate limit data from Anthropic's OAuth API. Previously it read the access token directly
from `~/.claude/.credentials.json` with no expiry check. When the token expired, `/usage` silently fell back to
DB-stored rate limit snapshots (less accurate).

Now `getValidAccessToken()` checks `expiresAt` with a 5-minute buffer and automatically refreshes via the standard
OAuth `refresh_token` grant. Updated credentials are written back to disk so the Claude CLI also benefits. If refresh
fails but the token hasn't technically expired yet, it still tries the existing token (grace window).

## Status Skill

- Removed main-channel-only restriction from `/status`. Any authorized group can now run it.
- Added `NANOCLAW_GROUP` env var to containers so the skill can display the actual group name instead of hardcoded "main".
- Added `/status` to the `READ_ONLY_COMMANDS` set so non-admin senders can use it.

## Gmail Re-authorization

Re-authorized Gmail OAuth credentials after expiry. No code changes needed -- just ran the MCP auth flow and
restarted the service.
