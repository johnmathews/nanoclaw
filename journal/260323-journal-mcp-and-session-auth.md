# Journal MCP Server and Session Command Fixes

Date: 2026-03-23

## Journal MCP Integration

### What

Added a new Slack channel (#journal, `C0AMU8US1PZ`) connected to the journal-agent MCP server running on the media VM
(`192.168.2.105:8400`). The journal-agent does OCR of handwritten journal pages, voice-to-text transcription, and
semantic search over journal entries.

### How

- Added `JOURNAL_MCP_URL` env var to `.env`, `container-runner.ts` (passthrough), and `agent-runner/src/index.ts`
  (HTTP MCP server config)
- Created `groups/slack_journal/` with CLAUDE.md describing the 7 MCP tools and config.json
- Registered the group in the DB with `requiresTrigger: false`
- Added `mcp__journal__*` to the allowed tools list

### DNS Rebinding Issue

The MCP Python SDK's `TransportSecurityMiddleware` rejects requests where the Host header doesn't match `localhost`.
Containers send the real IP as the Host header. Fix required on the journal-agent side:
`TransportSecuritySettings(enable_dns_rebinding_protection=False)` passed to `mcp.run()`.

## /clear Command Fix

### Problem

The SDK's built-in `/clear` command has `supportsNonInteractive=false`, so when forwarded to the SDK via `query()`,
it returned "Unknown skill: clear" instead of clearing the session.

### Solution

Handle `/clear` in the agent-runner before reaching the SDK. The agent-runner deletes the session `.jsonl` file
directly and returns `newSessionId: ''`. The host treats empty-string session IDs as a deletion signal, calling
`deleteSession()` and removing the in-memory entry.

Extracted `clearSessionFile()` into `utils.ts` for testability.

## Session Command Auth for Direct Conversation Channels

### Problem

Session-modifying commands (`/clear`, `/compact`, `/done`) required either main group membership or `is_from_me=true`.
In Slack, `is_from_me` is only true for bot messages, so users in non-main Slack channels couldn't run session
commands — they got "Session commands require admin access."

### Solution

Added `requiresTrigger` parameter to `isSessionCommandAllowed()`. Groups with `requiresTrigger=false` (direct
conversation channels where all senders are trusted) now allow session commands from any sender. This affects both
the `handleSessionCommand` auth check and the message loop's `closeStdin` gate.
