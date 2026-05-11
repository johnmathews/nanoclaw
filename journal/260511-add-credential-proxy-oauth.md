---
tags: [feature, decision]
---

# Credential Proxy and Max-Subscription OAuth Auth

Date: 2026-05-11

This fork runs NanoClaw on a personal Anthropic Max subscription instead of a billed API key. The mechanism is a
local HTTP credential proxy that the Claude Agent SDK inside each container is pointed at via `ANTHROPIC_BASE_URL`.
The proxy injects real credentials at the network boundary so containers never hold them. This is a fork-local
customization and should not be dropped during upstream cherry-picks (`/update-nanoclaw`).

## Motivation

Vanilla NanoClaw requires `ANTHROPIC_API_KEY` to be set and passed into containers. I want the agent to bill against
my Max subscription's OAuth credentials (`~/.claude/.credentials.json`) instead — the same credentials Claude Code
itself uses on this host. Goals:

1. No API key required. OAuth tokens from `~/.claude/.credentials.json` are sufficient.
2. The container's filesystem and environment must never contain the long-lived OAuth refresh/access tokens.
3. The unmodified upstream SDK has to work without forking it.

## Design

A small Node HTTP proxy (`src/credential-proxy.ts`, ~120 lines) listens on `127.0.0.1:CREDENTIAL_PROXY_PORT`
(default 3001). Containers receive `ANTHROPIC_BASE_URL=http://<host-gateway>:3001` and a placeholder credential.
The proxy forwards every request to `api.anthropic.com` with credentials injected.

Two modes detected at proxy startup by `detectAuthMode()`:

- **API-key mode** (`ANTHROPIC_API_KEY` set in `.env`): proxy strips any incoming `x-api-key` and injects the real
  one on every request. Container ships with `ANTHROPIC_API_KEY=placeholder`.
- **OAuth mode** (no API key, but `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` in `.env`): proxy injects
  the real OAuth token *only when the incoming request carries an `Authorization` header*. Container ships with
  `CLAUDE_CODE_OAUTH_TOKEN=placeholder`.

The OAuth-mode trick: the SDK's first call is `POST /api/oauth/claude_cli/create_api_key` carrying an
`Authorization: Bearer <placeholder>`. The proxy swaps the placeholder for the real OAuth token only on that call.
Anthropic returns a short-lived API key, the SDK uses `x-api-key` for everything after that, and the proxy passes
those subsequent requests through untouched. The long-lived OAuth token therefore crosses the wire exactly once
per container session and is never stored inside the container.

## Why a proxy and not env passthrough

Three options were on the table:

1. **Env passthrough** — set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` directly in the container env.
   Rejected: defeats the credential-isolation property the rest of NanoClaw works hard to maintain (`.env` shadow
   mount, mount allowlist, etc.). Any tool call that runs `env` or reads `/proc/self/environ` would leak the
   subscription credential.
2. **SDK fork** — patch the SDK to read from a mounted credential file. Rejected: hard to maintain across SDK
   upgrades; also doesn't solve the leakage problem.
3. **Credential proxy** (chosen) — single chokepoint, unmodified SDK, container only ever sees short-lived
   exchange-derived tokens.

## Implementation surface

- `src/credential-proxy.ts` — the proxy itself. Two-mode injection, hop-by-hop header stripping, response
  streaming via `pipe()`.
- `src/index.ts:983-987` — proxy started at process startup, before any channel connects.
- `src/container-runner.ts:290-294` — every container spawn sets
  `ANTHROPIC_BASE_URL=http://<gateway>:<port>` so the SDK targets the proxy.
- `src/container-runner.ts:99-101` — `.env` is shadow-mounted at `/dev/null` inside the container so even if a
  tool tried to read the host's `.env` from the mounted project root it would see an empty file.
- `src/host-commands.ts:108-209` — OAuth token lifecycle for the `/usage` host command. Reads
  `~/.claude/.credentials.json`, refreshes via `https://console.anthropic.com/v1/oauth/token` 5 minutes before
  expiry, and writes the refreshed token back to disk so the host's Claude CLI also benefits.
- `src/config.ts:50-53` — `CREDENTIAL_PROXY_PORT` config (default 3001, overridable).
- Documented in `docs/SECURITY.md` section 5 and `runbooks/architecture-overview.md`.

## Known limitations

These are real gotchas I haven't fixed yet — calling them out for future-me:

1. **Token-freshness drift.** The proxy reads `CLAUDE_CODE_OAUTH_TOKEN` from `.env` once at startup
   (`credential-proxy.ts:30-39`) and never re-reads. The refresh logic in `host-commands.ts` writes refreshed
   tokens to `~/.claude/.credentials.json` — a *different file* the proxy doesn't know about. If the proxy is
   running with an env-loaded token that expires (Max OAuth tokens last ~8h), it will keep injecting a stale
   one until the service restarts. The fact that this hasn't visibly broken is luck: in practice Claude Code
   on the host keeps `~/.claude/.credentials.json` warm, and `systemctl restart` happens often enough that the
   proxy gets a fresh env-loaded token. The right fix is to have the proxy call `getValidAccessToken()` (or a
   shared cache) on each exchange request rather than caching a static value.
2. **Full request buffering.** The proxy concatenates the entire request body before forwarding
   (`credential-proxy.ts:49-52`). Responses stream via `pipe()`, so SSE works, but large multimodal request
   bodies pay an extra memcpy and a small latency hit. A `req.pipe(upstream)` after writing headers would be
   cleaner. Low priority — request bodies are small relative to streamed responses.
3. **No health check or restart logic.** The proxy is a single in-process server with no liveness check from
   `health.ts` or `watchdog.ts`. If it dies, every container spawn fails opaquely. Add a check that opens a
   socket to the proxy port on every health probe.

## Isolation, honestly framed

`docs/SECURITY.md` previously said "agents cannot discover real credentials." That overstates it. The accurate
statement is: **long-lived** credentials (OAuth refresh/access tokens, the API key) never enter the container.
The **short-lived** API key the SDK gets back from the exchange does live in container memory and is sent on
every outbound request — that's how the SDK works, and there's no way around it without a deeper SDK rewrite.
SECURITY.md will be updated in this same change to reflect that.

## Fork-local — do not let upstream sync overwrite

The proxy is not in upstream NanoClaw. If a future `/update-nanoclaw` cherry-picks a refactor that touches
`src/container-runner.ts` around the container-spawn args, double-check that:

- `ANTHROPIC_BASE_URL` is still being set on the container.
- `startCredentialProxy` is still being called in `src/index.ts` before any channel connects.
- `.env` shadow mount is still in place.

Removing any one of these would either break OAuth auth or quietly leak the host's API key into containers.
