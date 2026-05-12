# Credential proxy — document subscription billing routing

## Why

The credential-proxy.md doc covered the security/isolation story thoroughly (one HTTP server, mode detection,
exchange dance, bind-host policy, weaknesses, alternatives) but didn't answer the operator-facing question:
*"does OAuth mode actually charge against my Claude Pro/Max subscription instead of per-token API billing?"*

That gap matters because:

- The answer (yes, plus the mechanism) is non-obvious from the code — the billing routing depends on a header the
  SDK sends, not anything the proxy does.
- Operators making changes to the proxy could inadvertently break subscription routing without realizing it (e.g.,
  by stripping the wrong header, synthesizing requests of their own, or accidentally re-implementing the OAuth
  flow — the exact pattern Anthropic started blocking for third-party harnesses in 2026).
- Future agents asked "do I need an API key" or "why did I provide a setup token" had no canonical doc to point
  to — only the security-trust-boundary framing in SECURITY.md §5.

## What changed

Three doc files, no code.

**`docs/credential-proxy.md`:**

- Added a paragraph to §4.2 "OAuth mode" explaining how the operator obtains the token (`claude setup-token`),
  what the `sk-ant-oat01-` prefix means, and where Claude Code stores the credential pair locally. This is the
  bridge between the abstract "host has an OAuth token" framing and the concrete operator action that produces
  one.
- Added a new §4.3 "Subscription billing — how it routes" covering:
  1. The three-part contract that triggers subscription billing — token format (`sk-ant-oat01-`), exchange
     endpoint (`/api/oauth/claude_cli/create_api_key`), and the SDK's `anthropic-beta: oauth-2025-04-20` header.
     Critically: the header is sent by the SDK, not by the proxy. Verified by grep — `anthropic-beta` does not
     appear in `src/credential-proxy.ts` at all; it only appears in `src/host-commands.ts:233` where the host
     queries `/api/oauth/usage` for the `/usage` command.
  2. The `ANTHROPIC_API_KEY` precedence gotcha — setting it anywhere `.env` can see silently switches the host
     to per-token API billing. Documented Anthropic's matching precedence rule and a `grep` check operators can
     run before service restarts.
  3. The April 2026 third-party-tool policy and why NanoClaw's design survives it: embedding the unmodified
     SDK and keeping the proxy strictly to a Bearer-value swap means client fingerprint reads as official
     Claude Code traffic. Added a maintenance rule for future edits: don't synthesize requests, don't rewrite
     paths, don't touch `anthropic-*` headers.

**`docs/SPEC.md` §7:**

- Added a paragraph linking directly to `credential-proxy.md#43-subscription-billing--how-it-routes` so the
  billing story is discoverable from the canonical spec.
- Extended the "see credential-proxy.md for..." deferral list to include "billing-routing mechanism."

**`docs/index.md`:**

- Extended the credential-proxy.md description in the docs table to mention "subscription-vs-API-key billing
  routing" so agents grepping the index for "subscription" find the doc.

## Decision rationale

A few choices worth recording:

**Why §4.3 instead of a new top-level section.** §4 is "The Two Auth Modes" — explaining what each mode means
for billing is a natural extension. Promoting it to §5 would have renumbered §5-§15 and forced edits across all
the internal cross-references (§11.1, §13.2, §13.7, etc.) for no gain. The §X.Y nesting keeps existing references
stable.

**Why explain the third-party policy in the doc rather than the journal.** The journal documents one-time
decisions; the policy is an ongoing constraint that affects how the proxy must continue to be modified. Future
agents editing the proxy need this as a forward-looking rule, not a historical footnote. Hence the doc.

**Why not also update SECURITY.md.** SECURITY.md §5's framing is trust/isolation, not billing. It already
correctly defers to credential-proxy.md for "full design." Adding a billing paragraph there would have created
two places to maintain the same fact. The SPEC.md update is sufficient cross-doc discoverability.

**Why not modify the journal entry `260511-add-credential-proxy-oauth.md`.** That entry is a frozen-in-time
decision record from when the proxy was first added. Journal entries shouldn't be edited after the fact — the
new context belongs in the canonical doc (which is meant to be kept current), not in the historical record.

## Verification

- `grep anthropic-beta src/credential-proxy.ts` returns 0 matches (verified — the proxy genuinely does not
  touch this header).
- `grep anthropic-beta src/host-commands.ts` returns 1 match at line 233 (the `/usage` command's call to
  `/api/oauth/usage`).
- Host's `.env` checked: contains `CLAUDE_CODE_OAUTH_TOKEN=...`, no `ANTHROPIC_API_KEY` — host is currently in
  OAuth/subscription mode, consistent with the docs.
- `~/.claude/.credentials.json` confirmed mode `0600`, access token starts `sk-ant-oat01-`, matching the
  documented format.
- `npm run format:check` passes (TS prettier; markdown not covered).
