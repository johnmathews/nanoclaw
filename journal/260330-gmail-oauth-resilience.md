# Gmail OAuth Resilience & Logger Pino Compatibility

## Context

After publishing the Google OAuth app (moved from "Testing" to "Production" to eliminate the 7-day
refresh token expiry), the existing expired token crashed the entire NanoClaw service on startup.
Two separate issues surfaced:

1. **Gmail `invalid_grant` crash** — `GmailChannel.connect()` called `getProfile()` without a
   try/catch. An expired/revoked OAuth token threw an unhandled error that killed the process.

2. **`logger.child is not a function`** — the recent pino-to-built-in-logger migration (79bc2fc)
   removed the `.child()` method that baileys (WhatsApp library) requires. baileys passes the
   logger to `makeWASocket()` and `makeCacheableSignalKeyStore()`, both of which call `.child()`.

## Changes

### `src/channels/gmail.ts`
- Wrapped `getProfile()` verification in try/catch
- On `invalid_grant`, logs an actionable error message and returns (Gmail channel skipped but
  service stays up)
- All other errors still throw (fail-fast for unexpected issues)

### `src/logger.ts`
- Refactored from a plain object to a `createLogger()` factory function
- Added `child(bindings)` — creates a new logger that merges parent bindings into every log call
- Added `trace()` as a noop (baileys calls it extensively for wire-level debug)
- Added `level` property for pino interface compatibility
- Exported `Logger` interface for type safety

### `scripts/gmail-reauth.ts`
- Standalone OAuth re-authentication script for when tokens expire
- Reads client credentials from `~/.gmail-mcp/gcp-oauth.keys.json`
- Generates auth URL, accepts code from redirect, writes new tokens
- Writes `credentials.json` with mode `0o600` (owner-only)

### Tests
- `src/channels/gmail.test.ts` — added test for graceful degradation on `invalid_grant`
- `src/logger.test.ts` — new test file covering `child()` nesting, method presence, `level` property

## Decision: Google OAuth App Publishing

Publishing the OAuth app was safe because:
- OAuth consent screen scopes are informational only — actual scopes are requested at flow time
- Client credentials stay on the server (not exposed publicly)
- Redirect URIs are localhost-only (no public OAuth callback endpoint)
- Publishing just removes the 7-day token expiry for testing-mode apps
