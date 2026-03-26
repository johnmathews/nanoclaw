# Add Google Calendar MCP Server

**Date:** 2026-03-26

## What

Added Google Calendar MCP server (`@cocal/google-calendar-mcp`) to agent containers, allowing agents to read and manage
Google Calendar events.

## Changes

- **Agent-runner** (`container/agent-runner/src/index.ts`): Added `google-calendar` MCP server config using
  `@cocal/google-calendar-mcp` via npx. Shares OAuth credentials with Gmail (`gcp-oauth.keys.json`). Added
  `mcp__google-calendar__*` to allowed tools.
- **Container runner** (`src/container-runner.ts`): Added volume mount for `~/.config/google-calendar-mcp/` token
  directory — writable so the MCP server can refresh OAuth tokens.

## Design Decisions

- **Unconditional configuration**: Like Gmail, the calendar MCP is always configured (not gated by an env var). Both use
  the same GCP OAuth project, so if Gmail works, Calendar should too.
- **Shared OAuth credentials**: The calendar MCP reads `gcp-oauth.keys.json` from the Gmail credentials directory rather
  than maintaining a separate copy. Token storage is separate (`~/.config/google-calendar-mcp/`) since the MCP library
  manages its own token refresh cycle.
- **Writable mount**: The token directory mount is writable because the MCP server needs to persist refreshed OAuth
  tokens between container spawns.
