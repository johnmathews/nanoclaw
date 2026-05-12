# Using a Claude Pro/Max Subscription in a Custom Tool

**Audience:** developers building a custom tool, harness, or script that calls Anthropic models and want it to
bill against an existing Claude.ai Pro/Max/Team/Enterprise subscription rather than per-token API charges.

**Status:** topical reference. Cross-references [credential-proxy.md](credential-proxy.md) for the isolation
pattern NanoClaw layers on top of this.

---

## Read this first — policy boundary

Anthropic's policy on subscription-OAuth use is nuanced and has tightened in 2026. Three categories matter:

- **Personal use (allowed).** You run a tool on your own machine, using your own subscription, for your own work.
  The official Claude Code CLI, the Claude Desktop app, and personal scripts that use the official SDKs against
  your own token all fall here. NanoClaw is an example: each install authenticates to *its operator's* own
  subscription on the operator's own infrastructure.
- **Self-hosted personal automation (gray, generally OK in practice).** Tools you self-host but that interact
  with messaging platforms, schedulers, or other surfaces — still using your own subscription, still your own
  machine. This is NanoClaw's deployment model. Currently allowed in practice but not explicitly endorsed.
- **Third-party product offerings (prohibited).** A SaaS, hosted product, or distributed tool that lets *other*
  people sign in with their Claude.ai accounts (or that proxies subscription OAuth on behalf of customers).
  Anthropic's [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) is explicit: *"Unless
  previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits
  for their products, including agents built on the Claude Agent SDK. Please use the API key authentication
  methods described in this document instead."* Multiple third-party harnesses (e.g. OpenClaw) were blocked in
  Q1 2026 against `anthropic-beta: oauth-2025-04-20`.

The rest of this document describes the *personal-use* path. If you are building a product to offer to other
users, this is not the path — use API keys from the Anthropic Console with per-token billing instead.

---

## The three things that matter, ranked

If you take nothing else from this doc, remember these in order:

1. **Use the right SDK package.** Embedding `@anthropic-ai/claude-agent-sdk` (or its Python equivalent) is what
   makes everything else work. The wrong SDK (or no SDK) forces you to re-implement the OAuth exchange flow
   yourself — and that path is exactly what Anthropic now rejects.
2. **Use the setup token.** It's the one-time bridge from your interactive Claude.ai session to a programmatic
   credential your tool can use. Without it, your tool has no way to authenticate against your subscription.
3. **Do not touch the custom headers.** The Agent SDK and its bundled `claude` CLI emit the headers Anthropic
   uses to route requests against your subscription (most importantly `anthropic-beta: oauth-2025-04-20`). If you
   add, remove, or modify these — or worse, synthesize HTTP requests yourself — you stop looking like official
   Claude Code traffic, and Anthropic blocks the request.

Each of these is expanded below.

---

## §1 — The SDK: which package, what version, why it matters

### The package you want

| Language       | Package                          | Registry | Notes                                              |
| -------------- | -------------------------------- | -------- | -------------------------------------------------- |
| TypeScript/Node | `@anthropic-ai/claude-agent-sdk` | npm      | Current stable: 0.2.139 (May 2026). NanoClaw uses ^0.2.92. |
| Python         | `claude-agent-sdk`               | PyPI     | Current stable: 0.1.81 (May 2026).                 |

These two packages are **the Claude Agent SDK** — what was previously called the "Claude Code SDK" before the
2026 rename. They ship the full agent loop (tool use, file edits, MCP, hooks, session state, slash commands) and
— critically — bundle the `claude` CLI binary as a dependency. Your program calls a high-level `query(...)` (TS)
or equivalent, which spawns the bundled CLI under the hood. The CLI is what actually performs the OAuth
exchange, the temp-key cycling, the beta-header tagging, and every other detail of subscription-billed
authentication.

Install:

```bash
# TypeScript/Node
npm install @anthropic-ai/claude-agent-sdk

# Python
pip install claude-agent-sdk
```

### The package you do NOT want

| Package                | Registry | Purpose                              | Why it's wrong here                                       |
| ---------------------- | -------- | ------------------------------------ | --------------------------------------------------------- |
| `@anthropic-ai/sdk`    | npm      | Low-level Anthropic API client       | API-key auth only; no OAuth exchange; no agent loop.      |
| `anthropic`            | PyPI     | Low-level Python Anthropic client    | Same as above. Different package, same limitation.        |

The names are confusingly similar. **`@anthropic-ai/sdk` is the raw HTTP client for `api.anthropic.com`.** It
authenticates with `ANTHROPIC_API_KEY` and gives you `messages.create()` and similar primitives. It does **not**:

- Know about OAuth tokens.
- Know about the `/api/oauth/claude_cli/create_api_key` exchange endpoint.
- Set the `anthropic-beta: oauth-2025-04-20` header automatically.
- Handle temp-API-key cycling.
- Provide the agent loop (tools, sub-agents, MCP, sessions).

If you install `@anthropic-ai/sdk` and try to use it with a subscription OAuth token, you have two choices:

- Use it with an API key (per-token billing, no subscription routing — not what you wanted).
- Re-implement the OAuth exchange yourself: POST to `/api/oauth/claude_cli/create_api_key` with the OAuth token
  and the right beta header, parse the temp key out of the response, set it on subsequent requests, refresh
  before expiry, handle errors. **This is exactly the "third-party harness re-implementing the OAuth flow"
  pattern that Anthropic now blocks.** The HTTP 400 / `invalid_request_error` returned in those cases
  ([anthropics/claude-code#13770](https://github.com/anthropics/claude-code/issues/13770)) is Anthropic's
  enforcement: client fingerprint doesn't match official Claude Code, request rejected.

### Why version matters

The Agent SDK and the bundled CLI evolve together. New beta headers, new endpoints, refreshed OAuth scopes, and
new policy enforcement all ship as version bumps. **If you pin too old a version, you risk being on a
codepath Anthropic has stopped recognizing as official.** As of writing:

- Current `@anthropic-ai/claude-agent-sdk`: **0.2.139** (May 2026)
- Current `claude-agent-sdk` (Python): **0.1.81** (May 2026)
- NanoClaw's pin: **^0.2.92** — a minor behind, but the `^` allows minor-version updates within `0.2.x`.

Recommendation: pin loosely (`^0.2.x` or `>=0.2.x`) and bump regularly. If you see authentication failures after
months of working code, the first thing to check is whether the SDK is significantly behind upstream.

### What the SDK does NOT abstract for you

The SDK manages auth, the agent loop, and the model call shape. It does **not**:

- Choose your model — you pass `model: "claude-opus-4-7"` (or similar) explicitly.
- Manage your session storage — sessions are written to `~/.claude/` by the bundled CLI; if you want isolation
  between sessions you supply different `cwd`s and home directories.
- Provide credential isolation from your application code — the OAuth token still lives in the environment of
  whichever process you spawn the SDK from. If your tool runs untrusted code that could read its own env, see
  [credential-proxy.md](credential-proxy.md) for the isolation pattern NanoClaw uses.

---

## §2 — The setup token: what it is, how to get it, where it goes

The setup token is the credential you'll hand to your tool. It's how a one-time interactive auth turns into a
long-lived programmatic credential.

### Getting one

On a machine where Claude Code is already installed and you're logged in (i.e., you can run `claude` interactively
and it works against your Pro/Max plan), run:

```bash
claude setup-token
```

This:

1. Initiates an OAuth flow against your existing Claude.ai session.
2. Mints a long-lived credential pair: an access token (~8h lifetime) plus a refresh token (indefinite lifetime
   until you revoke it from claude.ai settings).
3. Prints the access token to stdout. **This is the token you copy.**
4. Stores the full credential record at `~/.claude/.credentials.json` (mode `0600`) so the local CLI can use it.

The printed token starts with **`sk-ant-oat01-`** — the prefix that identifies it as an OAuth Access Token bound
to a subscription account. Length is ~100 characters.

### Putting it where your tool can read it

Once you have the token, set it as an environment variable in the process that will run the SDK:

```bash
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

Or in a `.env` file your process loads. Or in your systemd unit's `Environment=` directive. The SDK reads it from
`process.env.CLAUDE_CODE_OAUTH_TOKEN` (or the Python equivalent).

`ANTHROPIC_AUTH_TOKEN` is accepted as a backward-compatible alias for the same value. Don't set both.

### Critical: do not also set ANTHROPIC_API_KEY

If `ANTHROPIC_API_KEY` is set anywhere visible to the SDK process, it silently takes precedence over
`CLAUDE_CODE_OAUTH_TOKEN`. The SDK will use API-key authentication and bill per-token to whichever Console
account that key belongs to — not your subscription.

Anthropic's authentication-precedence rule, from
[code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication):

> "If `ANTHROPIC_API_KEY` is set, Claude Code will use this API key for authentication instead of your Claude
> subscription, resulting in API usage charges rather than using your subscription's included usage."

Audit before deploying:

```bash
# Should return exactly one line (the OAuth token), nothing else.
env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)='

# In a .env file:
grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)=' .env

# In a systemd unit, check the rendered environment:
systemctl --user show your-service.service -p Environment
```

### Token lifetime and refresh

- The **access token** lives ~8 hours.
- The **refresh token** lives indefinitely until revoked.
- The bundled `claude` CLI refreshes the access token automatically when it gets within 5 minutes of expiry. It
  POSTs to `https://console.anthropic.com/v1/oauth/token` with `grant_type=refresh_token` and writes the new
  access token back to `~/.claude/.credentials.json`.
- **If your tool uses the SDK directly and the SDK invokes the bundled CLI, this Just Works.** You don't have
  to manage refresh.
- **If you cache the OAuth token from `.env` or env-var snapshots and never re-read,** you'll silently start
  failing after ~8h. (NanoClaw has this exact bug in its credential proxy — see
  [credential-proxy.md §11.1](credential-proxy.md#111-token-freshness-drift-in-oauth-mode).)

### Revoking

To revoke a token (e.g., the machine is decommissioned, you suspect leakage):

1. Go to claude.ai settings → Connections / API keys section
2. Find the entry for the OAuth client (it'll be labeled "Claude Code")
3. Revoke. The refresh token is immediately invalidated; the access token expires at its existing TTL.

---

## §3 — Custom headers: why you don't touch them

Three HTTP headers carry the contract between your tool and Anthropic's subscription-billing routing. The SDK
(via the bundled CLI) sets all three correctly. **Your job is to not interfere.**

### The headers

1. **`Authorization: Bearer sk-ant-oat01-<token>`** — sent on the OAuth exchange request *only*. This carries
   the long-lived OAuth token to the exchange endpoint.

2. **`anthropic-beta: oauth-2025-04-20`** — sent on the same exchange request. This is Anthropic's "this is
   OAuth-bound, route to subscription" flag. Without it, the exchange endpoint returns 400.

3. **`x-api-key: sk-ant-api03-<temp>`** — sent on every subsequent inference request (e.g., `POST /v1/messages`).
   The temp key is short-lived (lifetime minutes) and is what the exchange endpoint returned. It carries the
   subscription binding to inference calls.

### The flow Anthropic looks for

Roughly:

```
SDK → POST /api/oauth/claude_cli/create_api_key
       Authorization: Bearer sk-ant-oat01-...
       anthropic-beta: oauth-2025-04-20
       User-Agent: claude-cli/<version>      ← also part of the fingerprint

Anthropic → 200 OK
            { "api_key": "sk-ant-api03-<temp>", "expires_at": ... }

SDK → POST /v1/messages
       x-api-key: sk-ant-api03-<temp>
       (no Authorization header, no anthropic-beta header)
```

Anthropic's billing routing depends on the exchange call succeeding with all three signals (token format,
endpoint path, beta header) plus a client fingerprint (User-Agent, request shape, body schema) that matches
official Claude Code. When that exchange succeeds, the temp key it returns inherits the subscription binding,
and inference calls using that key bill against the subscription.

### What "don't touch" means in practice

**If you're using the SDK normally, you're fine.** The CLI it bundles handles all of this. The points below are
for people tempted to "improve" on the SDK's behavior.

- **Don't add or modify any `anthropic-*` header.** The SDK sets `anthropic-version`, `anthropic-beta`, etc. Let it.
- **Don't synthesize OAuth requests yourself.** If you find yourself writing code that posts to
  `/api/oauth/claude_cli/create_api_key`, stop. You're now in the "third-party harness re-implementing OAuth"
  category that Anthropic blocks.
- **Don't replace the SDK's HTTP transport.** Some SDKs let you swap the underlying fetch/agent. If you do that
  for the Agent SDK, make sure your replacement preserves every header and the User-Agent value byte-for-byte.
- **Don't strip headers in a proxy.** If you're putting a proxy in front of the SDK (like NanoClaw's credential
  proxy), it's safe to *swap the value* of `Authorization: Bearer` (NanoClaw does exactly this), but not safe
  to strip `anthropic-beta` or `User-Agent`. The maintenance rule:
  [credential-proxy.md §4.3](credential-proxy.md#43-subscription-billing--how-it-routes) describes the exact
  scope a transparent proxy can safely take.

### The one custom header you CAN look at (read-only)

If you're trying to validate subscription billing is working, you can run a debugging proxy and observe traffic.
The `anthropic-beta` header on outbound calls is the single best signal: if you see `oauth-2025-04-20` on the
exchange call, the SDK is doing the right thing. If you don't see it, something is wrong (wrong SDK, wrong
version, or you've replaced the transport).

---

## Step-by-step setup (TypeScript / Node example)

```bash
# 1. Install the right SDK
npm install @anthropic-ai/claude-agent-sdk

# 2. On a machine with Claude Code authenticated, mint the token
claude setup-token
# → copy the printed sk-ant-oat01-... token

# 3. Set it in the environment of the process that will run the SDK
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# 4. Confirm ANTHROPIC_API_KEY is not set
unset ANTHROPIC_API_KEY   # if necessary

# 5. Run your tool
node my-tool.js
```

Your `my-tool.js` looks like:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Summarize this directory in one sentence.',
  options: {
    cwd: process.cwd(),
    model: 'claude-opus-4-7',
    // No auth config needed here — SDK reads CLAUDE_CODE_OAUTH_TOKEN
    // from process.env automatically.
  },
})) {
  console.log(message);
}
```

That's it. The first call will trigger the OAuth exchange transparently; subsequent calls reuse the temp key.
Refresh happens in the background.

---

## Step-by-step setup (Python example)

```bash
pip install claude-agent-sdk
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
unset ANTHROPIC_API_KEY
```

```python
from claude_agent_sdk import query

async def main():
    async for message in query(
        prompt="Summarize this directory in one sentence.",
        options={"cwd": ".", "model": "claude-opus-4-7"},
    ):
        print(message)

import asyncio
asyncio.run(main())
```

---

## Validation

After setup, confirm subscription billing is actually happening:

1. **Run a small query** and check it succeeds without an `ANTHROPIC_API_KEY` set.
2. **Check `claude /usage`** in a separate terminal (the CLI on the same machine as your token). The query you
   ran should show up in your subscription's recent activity.
3. **Check the Anthropic Console** (console.anthropic.com → Usage). The call should *not* appear there — that
   page shows API-key billing only. If it does appear, you're on per-token billing, not subscription.
4. **Inspect outbound headers** (only if you suspect something's wrong): run your tool through a debugging proxy
   like `mitmproxy` and confirm:
   - The exchange call carries `Authorization: Bearer sk-ant-oat01-...` and `anthropic-beta: oauth-2025-04-20`.
   - The inference calls carry `x-api-key: sk-ant-api03-...` (no `Authorization`, no `anthropic-beta`).
   - The User-Agent identifies as `claude-cli/<version>`.

If any of these checks fail, the most likely cause is one of: `ANTHROPIC_API_KEY` is set somewhere; you're
using `@anthropic-ai/sdk` instead of `@anthropic-ai/claude-agent-sdk`; or your SDK version is significantly
behind upstream.

---

## Common mistakes

1. **Installing the wrong SDK.** Easy to do — the names are similar. `@anthropic-ai/sdk` and
   `@anthropic-ai/claude-agent-sdk` are different packages. Same trap exists in Python (`anthropic` vs
   `claude-agent-sdk`).
2. **Setting `ANTHROPIC_API_KEY` alongside the OAuth token.** A leftover export in a shell rc, a `.env` line
   you forgot to delete, an env var in a CI pipeline — any of these silently route you to per-token billing
   without warning.
3. **Caching the OAuth token outside the SDK.** If you read it from a file at startup and never re-read, you'll
   fail silently after ~8h. Either re-read on each use, or let the SDK manage it (via the bundled CLI's
   `.credentials.json`).
4. **Synthesizing the exchange call yourself.** Tempting if you want a lightweight tool without the full SDK.
   Currently blocked by Anthropic — exchange requests from non-official clients return HTTP 400.
5. **Trying to use this for a multi-tenant product.** Anthropic's terms explicitly prohibit offering
   subscription OAuth as part of a third-party product. Use API keys (per-token billing) for products.
6. **Modifying outbound headers in a proxy.** Stripping `anthropic-beta` or rewriting `User-Agent` causes
   Anthropic to reject the request. If you must proxy, swap only the `Authorization` Bearer value; leave
   everything else alone.

---

## Adding credential isolation (optional)

The setup above puts the OAuth token in the environment of your SDK process. If that process runs untrusted
code — for example, an agent that executes user-supplied tool calls — the token is reachable to anything that
can read `/proc/self/environ` or `env`.

NanoClaw layers a transparent HTTP proxy on top of this to keep the real token on the host and only ever expose
a placeholder + a short-lived temp key inside the container. The pattern, threat model, and full implementation
are in [credential-proxy.md](credential-proxy.md). The key insight: as long as your proxy is a strict Bearer-value
swap and doesn't touch any other headers, you stay on the official-Claude-Code-traffic path and Anthropic's
billing routing continues to work.

If your tool doesn't run untrusted code, skip the proxy. The setup steps above are sufficient.

---

## Related documents

- [credential-proxy.md](credential-proxy.md) — NanoClaw's isolation pattern. See §4.3 for the billing-routing
  mechanism in detail.
- [SPEC.md §7](SPEC.md#7-credential-proxy) — short technical reference for NanoClaw's implementation.
- [SECURITY.md §5](SECURITY.md#5-credential-isolation-credential-proxy) — trust-model implications.
- [Anthropic — Authentication](https://code.claude.com/docs/en/authentication) — upstream docs on token formats
  and precedence rules.
- [Anthropic — Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) — including the
  third-party policy language.
- [anthropics/claude-code-typescript on GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
- [anthropics/claude-agent-sdk-python on GitHub](https://github.com/anthropics/claude-agent-sdk-python)
