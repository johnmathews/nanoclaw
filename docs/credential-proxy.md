# Credential Proxy

**Status:** fork-local feature, not in upstream NanoClaw.
**Implementation:** [`src/credential-proxy.ts`](../src/credential-proxy.ts) (~120 lines).
**Tests:** [`src/credential-proxy.test.ts`](../src/credential-proxy.test.ts).

This document explains how NanoClaw injects Anthropic credentials into containerised agents without ever placing the
real long-lived credentials inside the container. It is written as a reference for anyone (human or agent) building
a similar credential-isolation layer for an SDK they don't control.

---

## 1. What This Is

A small HTTP reverse proxy that sits between the Claude Agent SDK (running inside a container) and
`api.anthropic.com`. Containers are pointed at the proxy via `ANTHROPIC_BASE_URL`. The proxy injects real
authentication headers on the wire, so the container only ever holds **placeholder** values for the long-lived
credential.

The proxy supports two auth modes:

- **API key** — the host has a real `ANTHROPIC_API_KEY`. The proxy injects it as `x-api-key` on every forwarded
  request.
- **OAuth** (Claude Pro/Max subscription) — the host has an OAuth refresh/access token in
  `~/.claude/.credentials.json`. The SDK doesn't speak OAuth, but it does have a "gimme a temp API key" exchange
  endpoint that requires a Bearer token. The proxy injects the OAuth token *only on that exchange request*; the
  short-lived API key Anthropic returns is then used by the SDK directly via `x-api-key`.

The unmodified Claude Agent SDK works in both modes — the only thing that changes from the SDK's perspective is
the value of `ANTHROPIC_BASE_URL`.

## 2. The Problem

Two constraints are in tension:

1. **The container should be able to hold conversations with `api.anthropic.com`.** That requires authentication.
2. **The container must not be able to read the host's long-lived credentials.** A compromised agent — via prompt
   injection, malicious tool, or just `cat /proc/self/environ` — should not be able to exfiltrate the credential
   that bills the operator's account or grants long-lived access to the operator's subscription.

The naive option is to set `ANTHROPIC_API_KEY` directly in the container's environment. That puts the real
credential in:

- `/proc/self/environ` (readable by the agent process)
- The output of `env`, `printenv`
- Shell history if the agent ever runs `env > somefile`
- Stack traces, debugger output, error logs that include env

For a Claude Pro/Max user there's an additional problem: the operator doesn't have an API key at all. They have
an OAuth refresh token bound to their Anthropic account. Putting that token in the container would expose **the
operator's entire Anthropic account** to a compromised agent — strictly worse than exposing a billable API key.

The credential proxy resolves both: nothing the container holds is a long-lived credential, and the SDK doesn't
need to be modified to participate.

## 3. High-Level Design

```
┌──────────────────────────────────────────────────────────────────┐
│                       host process (trusted)                      │
│                                                                   │
│   ┌──────────────────────┐        reads .env              ┌────┐  │
│   │  credential proxy    │◄────────────────────────────── │.env│  │
│   │  (Node http server)  │  ANTHROPIC_API_KEY  or         └────┘  │
│   │  bound to docker0    │  CLAUDE_CODE_OAUTH_TOKEN                │
│   │  on Linux,           │                                          │
│   │  127.0.0.1 elsewhere │                                          │
│   └──────────┬───────────┘                                          │
│              │ outbound https request                                │
└──────────────┼─────────────────────────────────────────────────────┘
               │
               ▼
       ┌───────────────────┐
       │ api.anthropic.com │
       └───────────────────┘
               ▲
               │ all SDK traffic
┌──────────────┼─────────────────────────────────────────────────────┐
│   container  │            (sandboxed)                               │
│              │                                                      │
│   ┌──────────┴────────────┐                                         │
│   │  Claude Agent SDK     │                                         │
│   │  ANTHROPIC_BASE_URL = │                                         │
│   │  http://<gw>:3001     │   ← placeholder credential only         │
│   └───────────────────────┘                                         │
└──────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **Single chokepoint.** All SDK traffic must traverse the proxy to reach Anthropic. Credential injection happens
  in exactly one place; the rest of the system can ignore the question.
- **Unmodified SDK.** The SDK is configured by environment variables only (`ANTHROPIC_BASE_URL`). It doesn't know
  the proxy exists.
- **No credential ever in container env.** The container's env contains placeholders. Real credentials live in the
  host process's memory.
- **Credential lifetime narrowing in OAuth mode.** Even when the proxy injects the long-lived OAuth token, it does
  so onto a single exchange request. The container only ever receives a short-lived (TTL ~minutes) API key derived
  from that exchange.

## 4. The Two Auth Modes

### 4.1 API key mode

**Selected when:** `ANTHROPIC_API_KEY` is present in the host's `.env`.

**Container env:** `ANTHROPIC_API_KEY=placeholder`. The SDK boots with what it thinks is a key.

**Per-request handling:** the proxy strips any `x-api-key` header on incoming requests and injects the real key:

```typescript
if (authMode === 'api-key') {
  delete headers['x-api-key'];
  headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
}
```

This works for every request without exception. There's no exchange dance — the SDK uses `x-api-key`
unconditionally for all `/v1/messages` and similar endpoints, and the proxy unconditionally swaps it.

### 4.2 OAuth mode

**Selected when:** no `ANTHROPIC_API_KEY`, but `CLAUDE_CODE_OAUTH_TOKEN` (or the alias `ANTHROPIC_AUTH_TOKEN`) is
present in the host's `.env`.

**Container env:** `CLAUDE_CODE_OAUTH_TOKEN=placeholder`.

**Per-request handling:**

```typescript
} else {
  // OAuth mode: replace placeholder Bearer token with the real one
  // only when the container actually sends an Authorization header
  // (exchange request + auth probes). Post-exchange requests use
  // x-api-key only, so they pass through without token injection.
  if (headers['authorization']) {
    delete headers['authorization'];
    if (oauthToken) {
      headers['authorization'] = `Bearer ${oauthToken}`;
    }
  }
}
```

This is the entire OAuth integration. Three things make it work:

1. **The SDK *only* sets `Authorization: Bearer <CLAUDE_CODE_OAUTH_TOKEN>` on requests that are actually OAuth
   flows.** Specifically, on `POST /api/oauth/claude_cli/create_api_key` (the "exchange this OAuth token for a
   short-lived API key" call). For routine inference requests it uses `x-api-key`.
2. **The proxy's injection logic is gated on the presence of an `Authorization` header in the *incoming* request.**
   So for inference requests (which carry no `Authorization`), the proxy is a no-op and forwards as-is. The SDK's
   short-lived API key flows through untouched.
3. **The proxy doesn't care which Bearer is sent in.** The container sends `Bearer placeholder`, the proxy
   strips it and sets `Bearer <real-oauth-token>`. The container could send `Bearer anything` and the proxy
   would still inject the real token.

Result: the long-lived OAuth token crosses the wire **once per container session** (during the first exchange
request) and never enters the container's environment, filesystem, or stdin.

## 5. Wire-Level Request Flow

### 5.1 API-key mode

```
SDK → proxy:
  POST /v1/messages
  Host: api.anthropic.com
  x-api-key: placeholder
  content-type: application/json
  ...

proxy → api.anthropic.com:
  POST /v1/messages
  Host: api.anthropic.com
  x-api-key: sk-ant-api03-<real-key>           ← injected
  content-type: application/json
  ...

api.anthropic.com → proxy → SDK:
  200 OK
  content-type: application/json
  {... model response ...}
```

### 5.2 OAuth mode — first request (exchange)

```
SDK → proxy:
  POST /api/oauth/claude_cli/create_api_key
  Host: api.anthropic.com
  Authorization: Bearer placeholder            ← from container env
  content-type: application/json
  {... exchange payload ...}

proxy → api.anthropic.com:
  POST /api/oauth/claude_cli/create_api_key
  Host: api.anthropic.com
  Authorization: Bearer sk-ant-oat01-<real>    ← injected (long-lived OAuth token)
  content-type: application/json
  {... exchange payload ...}

api.anthropic.com → proxy → SDK:
  200 OK
  content-type: application/json
  { "api_key": "sk-ant-api03-<temp-short-lived-key>", ... }
```

The SDK extracts the temp API key from the response body and uses it for every subsequent call.

### 5.3 OAuth mode — subsequent requests (post-exchange)

```
SDK → proxy:
  POST /v1/messages
  Host: api.anthropic.com
  x-api-key: sk-ant-api03-<temp-short-lived-key>   ← from exchange response
  content-type: application/json
  ...

proxy → api.anthropic.com:
  POST /v1/messages
  Host: api.anthropic.com
  x-api-key: sk-ant-api03-<temp-short-lived-key>   ← unchanged: no Authorization header → no injection
  content-type: application/json
  ...
```

The proxy is fully transparent for these requests. Note that the temp key now lives in container memory — see §13.2.

## 6. Implementation Walkthrough

### 6.1 Mode detection at startup

```typescript
const secrets = readEnvFile([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
]);

const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
```

The proxy is a function of its env at startup. **It does not re-read `.env` later.** This is a real limitation
in OAuth mode — see §13.1 and §15.1.

A separate `detectAuthMode()` export lets `container-runner.ts` decide which placeholder env var to inject into
spawning containers without re-implementing the same logic.

### 6.2 Per-request handler

The HTTP server's request handler runs for every incoming request:

```typescript
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers, host: upstreamUrl.host, 'content-length': body.length };

    // Strip hop-by-hop headers
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    // Mode-specific credential injection
    if (authMode === 'api-key') { /* ... */ } else { /* ... */ }

    const upstream = makeRequest({ hostname, port, path: req.url, method: req.method, headers }, (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);   // streamed response
    });
    upstream.on('error', (err) => { /* 502 */ });
    upstream.write(body);
    upstream.end();
  });
});
```

Notes:

- **Request body is buffered.** Concatenating into `chunks` before forwarding. Simple, but suboptimal for very
  large multimodal payloads — see §13.3.
- **Response body is streamed.** `upRes.pipe(res)` so SSE / token streaming work correctly.
- **Hop-by-hop headers are stripped** per RFC 2616 §13.5.1. `Connection`, `Keep-Alive`, `Transfer-Encoding` must
  not be forwarded by intermediaries; if forwarded, they confuse keep-alive negotiation between the client and the
  upstream.
- **Host header is rewritten** to the upstream's host so SNI and HTTP/1.1 host-based routing work at the upstream.
- **Errors return 502 Bad Gateway** with the upstream error logged.

### 6.3 Container env wiring

In `src/container-runner.ts`:

```typescript
args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`);

if (authMode === 'api-key') {
  args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
} else {
  args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
}
```

`CONTAINER_HOST_GATEWAY` is `host.docker.internal`. On Linux Docker that hostname isn't built in, so
`hostGatewayArgs()` returns `--add-host=host.docker.internal:host-gateway` to add it.

### 6.4 Bind host detection

The proxy binds to a runtime-specific address so non-container processes can't reach it:

```typescript
function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to docker0 bridge so only containers can reach it
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}
```

Why this matters: on bare-metal Linux, binding to `127.0.0.1` would mean only host processes can reach the proxy,
not containers (which see the host via the docker0 bridge). Binding to `0.0.0.0` would mean any host process can
hit the proxy and exfiltrate credentials by relaying a request through it. Binding to docker0 specifically lets
containers in but keeps host processes out.

`CREDENTIAL_PROXY_HOST` env var overrides the auto-detection for unusual setups (custom bridge networks, host
networking mode, etc.).

### 6.5 What the agent-runner sees

`container/agent-runner/src/index.ts` does no special credential handling — it just inherits `process.env` and
passes it through to the SDK:

```typescript
// Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
// No real secrets exist in the container environment.
const sdkEnv: Record<string, string | undefined> = {
  ...process.env,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
};
```

This is the cleanest possible integration: the SDK is a black box, and the agent-runner does nothing other than
hand it the placeholder env it received.

## 7. Token Refresh Lifecycle

The proxy itself does **not** refresh OAuth tokens. Token refresh lives in `src/host-commands.ts` and is invoked
by the `/usage` chat command. The relevant pieces:

```typescript
const TOKEN_REFRESH_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';   // Claude Code's OAuth client ID
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function getValidAccessToken(): Promise<string | null> {
  let creds = readCredentials();   // reads ~/.claude/.credentials.json
  if (!creds?.claudeAiOauth?.accessToken) return null;

  const { expiresAt } = creds.claudeAiOauth;
  if (expiresAt && Date.now() >= expiresAt - REFRESH_BUFFER_MS) {
    const refreshed = await refreshOAuthToken(creds);
    if (refreshed) creds = refreshed;
    else { /* fallback: re-read in case Claude Code refreshed it externally */ }
  }
  return creds.claudeAiOauth.accessToken;
}
```

`refreshOAuthToken()` POSTs to the OAuth token endpoint with `grant_type=refresh_token` and writes the new
credentials back to `~/.claude/.credentials.json` so the host's Claude Code CLI also benefits.

**Important architectural gap:** the proxy reads `CLAUDE_CODE_OAUTH_TOKEN` from `.env` once at startup. It does
not read `~/.claude/.credentials.json`, and `host-commands.ts` does not push refreshed tokens to the proxy. The
two halves of OAuth handling are not actually wired together. See §13.1.

## 8. Configuration Reference

| Variable                  | Where      | Default     | Purpose                                                   |
| ------------------------- | ---------- | ----------- | --------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | host .env  | —           | Selects api-key mode if set                               |
| `CLAUDE_CODE_OAUTH_TOKEN` | host .env  | —           | Selects oauth mode if no API key. Loaded by proxy at startup |
| `ANTHROPIC_AUTH_TOKEN`    | host .env  | —           | Alias for `CLAUDE_CODE_OAUTH_TOKEN`                       |
| `ANTHROPIC_BASE_URL`      | host .env  | `https://api.anthropic.com` | Proxy upstream. In containers, set to the proxy address. |
| `CREDENTIAL_PROXY_PORT`   | host env   | `3001`      | Listen port                                               |
| `CREDENTIAL_PROXY_HOST`   | host env   | auto        | Bind address override                                     |

Per-container env (set by `container-runner.ts`):

| Variable                  | Value                                                      |
| ------------------------- | ---------------------------------------------------------- |
| `ANTHROPIC_BASE_URL`      | `http://host.docker.internal:<CREDENTIAL_PROXY_PORT>`      |
| `ANTHROPIC_API_KEY`       | `placeholder` (api-key mode)                               |
| `CLAUDE_CODE_OAUTH_TOKEN` | `placeholder` (oauth mode)                                 |

## 9. Testing

`src/credential-proxy.test.ts` runs the proxy against a fake upstream and asserts header behavior:

| Test                                                                | Asserts                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| API-key mode injects `x-api-key` and strips placeholder             | Real key replaces placeholder on every request                   |
| OAuth mode replaces `Authorization` when container sends one        | Real OAuth token replaces `Bearer placeholder` on exchange       |
| OAuth mode does NOT inject `Authorization` when container omits it  | Post-exchange `x-api-key` requests pass through untouched        |
| Strips hop-by-hop headers                                           | `keep-alive`, `transfer-encoding` not forwarded                  |
| Returns 502 when upstream is unreachable                            | Connection failures surface as proper HTTP error                 |

The tests don't cover: bind-host detection, response streaming (SSE) behavior, or token refresh.

## 10. Strengths

### 10.1 Surgical integration with an unmodified SDK

The SDK is configured with one environment variable. There is no fork, no monkey-patching, no SDK upgrade pain.
When the SDK ships v0.2.93, v0.3.0, etc., this integration keeps working as long as the SDK still respects
`ANTHROPIC_BASE_URL` and still uses `Authorization: Bearer ...` on the exchange endpoint and `x-api-key`
elsewhere. Both are stable contracts.

### 10.2 Dual-mode with no code branches at the call site

Every container is spawned the same way: `ANTHROPIC_BASE_URL=<proxy>` plus a placeholder. The container-runner
doesn't have to know which auth mode the host is in; the proxy figures it out. Adding a third auth mode (e.g.
Bedrock cross-account assume-role) would be a change to the proxy only.

### 10.3 OAuth credential never enters container

This is a real, measurable security improvement over env-passthrough. A compromised agent that exfiltrates
`/proc/self/environ`, `env`, or any in-container file gets `placeholder`. The worst they can leak is the temp
exchange key (see §13.2).

### 10.4 Simple, auditable code

~120 lines of pure Node, no dependencies beyond the standard library. Easy to read end-to-end and reason about.
Easy to test (the test file is itself ~190 lines and exercises every code path).

### 10.5 Defensible bind-host policy on Linux

Binding to docker0 specifically (rather than 0.0.0.0 or 127.0.0.1) is a meaningful defense in depth: it prevents
host processes outside Docker from using the proxy as a credential-laundering relay.

### 10.6 Tests that exercise the protocol, not the implementation

The tests stand up a real HTTP server and assert on what reaches the upstream. They will continue to pass through
internal refactors as long as the protocol behavior is preserved.

## 11. Weaknesses

### 11.1 Token-freshness drift in OAuth mode (most important)

The proxy snapshots `CLAUDE_CODE_OAUTH_TOKEN` from `.env` at startup. Max OAuth tokens have ~8 hour lifetimes.
After expiry, the proxy will keep injecting a stale token onto exchange requests, and Anthropic will return 401.
The refresh logic in `host-commands.ts` writes new tokens to `~/.claude/.credentials.json` — a different file the
proxy never reads.

In practice this hasn't surfaced often because (a) Claude Code on the host keeps `~/.claude/.credentials.json`
warm, and (b) `systemctl restart` happens often enough that the proxy gets a fresh load. But it is a latent
footgun, and the failure mode is "agent stops responding mid-conversation" with no obvious cause.

### 11.2 Container memory holds short-lived API key

In OAuth mode, the temp `sk-ant-...` key the SDK exchanges for lives in the container's process memory and goes
out on every request. A compromised agent can read it from its own memory or sniff outbound headers. The blast
radius is bounded (key is short-lived, can't be used to mint a new long-lived token), but documents calling the
container "credential-free" are technically inaccurate.

### 11.3 Full request body buffering

Bodies are accumulated in a Buffer before forwarding. For typical /v1/messages requests this is fine, but large
multimodal payloads (e.g. several MB of images) pay an extra memcpy and added latency. Streaming the request
body via `req.pipe(upstream)` after writing headers would be cleaner.

### 11.4 No proxy health check or restart logic

If the proxy crashes, every container spawn fails opaquely (the SDK gets connection-refused on
`ANTHROPIC_BASE_URL`, propagates as an inscrutable error). The proxy is not part of `health.ts` or `watchdog.ts`.

### 11.5 Single in-process server, no rate limiting

The proxy doesn't track per-container request rates. A runaway agent in one container can saturate the OAuth
token's rate limit, affecting all other containers and the user's normal Claude Code use on the host.

### 11.6 No structured request logging

Errors get logged, but successful requests don't. There's no way to ask "what did container X send to Anthropic in
the last 5 minutes" without packet capture. For an auth-injecting proxy, this is a missed observability win.

### 11.7 No upstream allowlist

The proxy will forward to any path the SDK requests on whatever `ANTHROPIC_BASE_URL` is set to. If a future SDK
version started calling endpoints the operator wants to block (e.g. analytics, telemetry), the proxy has nowhere
to enforce that. A trivial path allowlist would close this.

### 11.8 No request-shape validation

The proxy doesn't inspect that incoming requests look like real SDK requests. A non-SDK process inside a container
could craft arbitrary requests to the proxy and have them credential-stamped. Mitigation today: containers don't
have arbitrary processes — only the agent-runner. But the proxy itself doesn't enforce that assumption.

### 11.9 Tests don't cover streaming responses

The tests assert headers, status codes, and proxying behavior, but not that SSE / chunked-encoding response
streams flow correctly end-to-end. A regression here would only surface in production.

### 11.10 No multi-tenant support

If you wanted to run NanoClaw with multiple isolated operator accounts on the same host, the proxy has no notion
of which container belongs to which account. All containers see all credentials.

## 12. How to Improve

Concrete, prioritized improvements. The top three would substantially harden the proxy; everything else is
incremental.

### 12.1 Wire up token refresh (high priority)

Replace the snapshot-at-startup with a function call:

```typescript
import { getValidAccessToken } from './host-commands.js';   // already exists

// inside the per-request handler, in OAuth mode:
if (headers['authorization']) {
  delete headers['authorization'];
  const token = await getValidAccessToken();   // refreshes if expiring
  if (token) headers['authorization'] = `Bearer ${token}`;
}
```

This makes the proxy share the host's authoritative token state and eliminates the staleness drift. Cost: makes
the request handler async, and adds a credential-file read to every exchange request (minor — exchanges are
rare).

A cache with a short TTL (~30s) avoids the per-request file read while still picking up refreshes within seconds.

### 12.2 Add proxy to health checks (high priority)

Two pieces:

- A liveness check: `health.ts` opens a socket to the proxy port; failure = degraded status.
- A startup gate: `index.ts` should not register channels until the proxy successfully accepts a `HEAD /` (or
  similar). Today they're started in order but no readiness handshake exists.

A misbehaving proxy is one of the few host-process problems that produces zero log output and zero `/health`
signal — both of which we expect to catch every other class of failure.

### 12.3 Stream request bodies (medium priority)

Replace the buffered concat with a pipe:

```typescript
const upstream = makeRequest({ hostname, port, path: req.url, method: req.method, headers }, ...);
req.pipe(upstream);   // streamed in
```

Headers must be set before the first byte hits the upstream, so credential injection moves from `req.on('end')`
to immediately on request arrival. This requires reading hop-by-hop and `host` adjustments synchronously, which
is fine.

### 12.4 Path allowlist (medium priority)

Maintain an explicit list of paths the proxy is willing to forward, defaulting to `/v1/*` and
`/api/oauth/claude_cli/*`. Reject everything else with 404. Closes off any future SDK behavior that the operator
hasn't explicitly authorized.

### 12.5 Per-container request logging (low priority)

If `ANTHROPIC_BASE_URL` carries a `?container=<name>` suffix when each container is spawned, the proxy can attach
that label to every log line for that connection. Cost: trivial. Benefit: post-incident "what did container X
do" becomes a `grep`.

### 12.6 Per-container rate limiting (low priority)

With container labels in place, add a token-bucket per container. Drop excess requests with 429. Saves the host
from one container exhausting the global quota.

### 12.7 Multi-tenant credential routing (advanced)

Map `host.docker.internal:3001` → `host.docker.internal:3010` (operator A) and
`host.docker.internal:3011` (operator B), and run an instance of the proxy per operator. Container-runner
sets `ANTHROPIC_BASE_URL` accordingly per group. No proxy code change needed; just orchestration.

### 12.8 Tests for streaming and refresh

Two test suites worth adding:

- An SSE round-trip: upstream returns chunked `text/event-stream`, assert client sees each chunk in order.
- Refresh-during-flight: mock `getValidAccessToken()` to return different values across calls, assert injection
  picks up the new token.

## 13. Building a Similar Tool

If you're building a credential proxy for some other SDK + container system, the principles below generalize.

### 13.1 Design around the SDK's existing extension points

The single most important feature of this design is that **it requires no SDK changes**. We use exactly one knob
the SDK already exposes (`ANTHROPIC_BASE_URL`) and exactly one credential format the SDK already supports
(placeholder values that get swapped on the wire).

Before you write any code, list the SDK's configurable knobs:

- Base URL? (most HTTP SDKs have this — this is the universal "redirect me" hook)
- Custom HTTP transport / agent? (some SDKs let you pass a Node `http.Agent` or fetch implementation; even cleaner)
- Custom auth provider? (some SDKs let you supply a callback that returns a token; the cleanest of all)

If the SDK has a custom auth provider, a proxy may be overkill — implement the provider and call your refresh
logic inline. Use a proxy when the SDK only exposes a base URL or transport.

### 13.2 Find the credential's narrowest possible scope

NanoClaw's biggest win is that the long-lived OAuth token only crosses the wire on the exchange request. We didn't
design that — we noticed the SDK was already doing it (the SDK uses Bearer for OAuth flows and `x-api-key` for
inference) and gated injection on the presence of the `Authorization` header.

For your SDK, ask: *what's the smallest subset of requests where the long-lived credential must be present?* You
might find:

- An auth endpoint vs inference endpoints (NanoClaw's case)
- An "admin" base URL vs a "data" base URL
- A specific HTTP method (e.g. only OPTIONS preflight needs the credential)

Inject only on those requests. The container then never sees the long-lived value, even within the proxy.

### 13.3 Pick a bind address that excludes adjacent attackers

Where the proxy listens determines who can use it. The right answer depends on your container runtime:

- **Docker Desktop on macOS/WSL** — bind to `127.0.0.1`. The VM routes `host.docker.internal` to host loopback,
  so containers can reach it; nothing on the host network can.
- **Bare-metal Docker on Linux** — bind to the docker bridge IP (`docker0` by default). Containers can reach it;
  host processes outside Docker can't.
- **Kubernetes / multi-node** — bind to a per-pod sidecar address; never to `0.0.0.0`.
- **Apple Container** — same as Docker Desktop on macOS.

Avoid `0.0.0.0` unless you've explicitly thought through your network model. Make the bind address overridable
(via env var) for unusual setups.

### 13.4 Strip hop-by-hop headers

Per RFC 2616 §13.5.1: `Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailers`,
`Transfer-Encoding`, `Upgrade`. Forwarding these to upstream confuses keep-alive negotiation and may break
streaming responses. Forward everything else verbatim.

### 13.5 Stream the response

For LLM SDKs especially, responses are streamed (SSE). `upstreamRes.pipe(clientRes)` is the simplest possible
correct implementation. Don't buffer — you'll break streaming.

### 13.6 Forward the request body, but consider streaming it

If your proxy ever needs to *inspect* the request body (e.g. to pick the bind address based on the model
requested), you'll have to buffer. Otherwise, `clientReq.pipe(upstreamReq)` is faster and uses less memory. We
don't pipe today; we should.

### 13.7 Don't snapshot credentials at startup

NanoClaw's biggest remaining bug. Always read the current credential at request time, with a small TTL cache to
avoid hot-path file IO. Push refresh logic into a single function (`getValidAccessToken()` here) and call it from
every site that needs a credential. If you can't share the function, a notification mechanism (file watch,
inotify, signal) at least gives you re-read on demand.

### 13.8 Test against the protocol, not the implementation

NanoClaw's tests stand up a fake upstream HTTP server and assert what bytes reach it. This is robust to internal
refactors and catches the things that actually matter — header injection, stripping, status propagation. Don't
unit-test the proxy by mocking `http.request`; integration-test it by mocking the *upstream*.

### 13.9 Keep the placeholder convention

Containers ship with `ANTHROPIC_API_KEY=placeholder`. This is intentional: SDKs commonly refuse to start without
a credential set, and many will skip auth entirely if the env var is absent. A literal string `placeholder`
satisfies the "is set" check while making it obvious in any debug output that the value is fake.

### 13.10 Run the proxy *before* anything else

`startCredentialProxy()` is awaited before any channel connects. If the proxy fails to start, the whole process
should refuse to come up — silent fallback to "no auth" is the worst possible outcome. Make this explicit in
your startup sequence.

## 14. Alternatives Considered

| Alternative                     | Why rejected                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Set real credentials in container env | Defeats credential isolation. A compromised agent reads `/proc/self/environ`.    |
| Mount a credentials file into container, set `ANTHROPIC_API_KEY_FILE` | SDK doesn't read this var; would require SDK fork. And the file is still readable by the agent. |
| Fork the SDK to read from a custom credential provider | Maintenance burden across SDK upgrades; doesn't solve the "credential lives in container" problem. |
| Per-container ephemeral API keys (host mints one, sets in env) | Requires API support for arbitrary key minting; Max OAuth doesn't expose this beyond the create_api_key flow we already use. |
| Pass credentials over a Unix socket the agent connects to | Equivalent isolation to the proxy, but we'd be inventing a protocol. HTTP works because the SDK already speaks it. |
| Mutual TLS between container and proxy | Useful if you don't trust the bind-address policy. Overkill for a single-host setup. |

## 15. Related Documents

- [SECURITY.md](SECURITY.md) — overall trust model. Now defers to this doc for credential proxy specifics.
- [SPEC.md §7](SPEC.md#7-credential-proxy) — short reference. Defers here for detail.
- [REQUIREMENTS.md](REQUIREMENTS.md) — why credential isolation is a goal at all.
- [journal/260511-add-credential-proxy-oauth.md](../journal/260511-add-credential-proxy-oauth.md) — frozen-in-time decision record.
- [src/credential-proxy.ts](../src/credential-proxy.ts) — the implementation.
- [src/credential-proxy.test.ts](../src/credential-proxy.test.ts) — the tests.
- [src/host-commands.ts](../src/host-commands.ts) — token refresh.
- [src/container-runner.ts](../src/container-runner.ts) — container env wiring.
- [src/container-runtime.ts](../src/container-runtime.ts) — bind-host detection.
