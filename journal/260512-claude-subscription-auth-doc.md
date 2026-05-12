# New doc: how to set up subscription billing in a different tool

## Why this is a separate doc from credential-proxy.md

After writing the §4.3 "Subscription billing — how it routes" content in `credential-proxy.md` earlier today, a
follow-on question surfaced: would that section actually serve as a how-to for someone building a *different*
tool that wants to use Claude Max subscription billing? Re-reading §4.3 with that audience in mind — no. It
explains the mechanism (the three-part contract: token format, exchange endpoint, beta header) and the
maintenance rule for NanoClaw's proxy, but it doesn't lay out the setup steps a new tool's author would follow.

The audiences for the two questions are different:

- `credential-proxy.md` audience: someone maintaining or extending NanoClaw's isolation layer, or building a
  similar proxy. They care about the mechanism because it constrains the proxy's design (don't touch headers,
  don't synthesize requests).
- New tool audience: someone building a CLI, a script, or a different harness who just wants their tool to bill
  against their Claude.ai subscription. Most don't need credential isolation at all — they just need to install
  the right SDK and set the right env var.

Conflating these would have either bloated `credential-proxy.md` past its scope, or forced the new-tool reader to
slog through 729 lines of proxy theory to find ~50 lines of setup steps.

## Policy nuance the research surfaced

When I asked a research agent to verify the SDK packages and OAuth mechanism, it returned a stronger framing of
Anthropic's policy than I'd had before. The Agent SDK overview at code.claude.com/docs/en/agent-sdk/overview is
explicit:

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate
> limits for their products, including agents built on the Claude Agent SDK. Please use the API key
> authentication methods described in this document instead."

The previous §4.3 framing in credential-proxy.md said NanoClaw "survives" Anthropic's third-party restrictions
because it uses the official SDK + transparent proxy. That framing is correct *for NanoClaw specifically*
because NanoClaw is personal tooling — each install authenticates to its operator's own subscription on the
operator's own infrastructure. It's the "personal use" pattern, not the "product offered to third parties"
pattern Anthropic prohibits.

The new doc explicitly draws this line for the reader's benefit — three categories (personal use allowed,
self-hosted automation gray, third-party product offerings prohibited) so anyone building a new tool can place
themselves on the right side of the line before reading the setup steps.

## SDK package research summary

The doc covers the SDK package question explicitly because it's the single most common way to get this wrong.

- **Right packages:** `@anthropic-ai/claude-agent-sdk` (npm, 0.2.139 current; NanoClaw on ^0.2.92) and
  `claude-agent-sdk` (PyPI, 0.1.81 current).
- **Wrong packages:** `@anthropic-ai/sdk` (npm) and `anthropic` (PyPI) — these are the *low-level* API clients
  that do API-key auth only. The names are confusingly similar.
- **Key distinction:** the Agent SDKs bundle the `claude` CLI binary as a dependency. The CLI is what actually
  performs the OAuth exchange against `/api/oauth/claude_cli/create_api_key`. The low-level SDKs don't include
  the CLI, so using them with an OAuth token forces the developer to re-implement the exchange flow themselves
  — which is exactly the third-party-harness pattern Anthropic now blocks.

This distinction wasn't documented anywhere in NanoClaw's /docs/ before today. It's worth surfacing because any
future contributor or fork-author who tries to "simplify" by switching to `@anthropic-ai/sdk` would silently
break subscription billing.

## What's in the new doc

`docs/claude-subscription-auth.md`. Structure:

- Policy boundary up front (personal use vs. self-hosted vs. third-party product)
- "The three things that matter, ranked" — covers the user's specific request (custom headers, setup token, SDK)
- §1 SDK packages — right ones, wrong ones, version pinning advice, what the SDK abstracts and doesn't
- §2 Setup token — `claude setup-token` flow, format, lifetime, storage, the `ANTHROPIC_API_KEY` precedence
  trap with an audit `grep` command
- §3 Custom headers — the three relevant headers, what role each plays, the "don't touch" rule and its
  rationale, the one header you can read for debugging
- Step-by-step examples for TS/Node and Python
- Validation checklist (run a query, check `/usage`, check Console for absence, optionally inspect with mitmproxy)
- Common mistakes list
- Optional credential-isolation cross-ref to `credential-proxy.md`
- Related-documents block

## Cross-references added

- `credential-proxy.md` §4.3 now opens with a blockquote pointing readers building a different tool to the new
  doc. The mechanism explanation stays in credential-proxy.md because it constrains the proxy's design.
- `docs/index.md` has a new row in the docs table for `claude-subscription-auth.md` with a description that
  makes the audience split obvious.

## Verification

- npm and PyPI versions confirmed via web search (`@anthropic-ai/claude-agent-sdk` 0.2.139,
  `@anthropic-ai/sdk` 0.95.2, `claude-agent-sdk` PyPI 0.1.81, `anthropic` PyPI 0.101.0).
- NanoClaw's pin verified via `container/agent-runner/package.json` — `^0.2.92`.
- Policy language verified against `code.claude.com/docs/en/agent-sdk/overview` (cited in the doc).
- Third-party-enforcement context verified against `anthropics/claude-code#13770` (also cited).
