# Fork Divergence

This document is the single index of features that exist in this fork of NanoClaw but are not part of upstream
[`qwibitai/nanoclaw`](https://github.com/qwibitai/nanoclaw). It exists because the fork has accumulated enough
divergence that a casual reader of the upstream README cannot predict which capabilities this tree has, and a casual
reader of this tree cannot easily tell what is fork-local versus what came from upstream. Each entry below points at
the code that implements it and, where one exists, the canonical doc that already covers it in depth.

## Authority

If this doc disagrees with the code, the code wins. Treat every entry here as a pointer, not as a specification.
Source files are cited as `path:line` so they can be opened and verified directly. The `Status` label on each entry
reflects how confident the documentation is that the feature is fork-local; "fork-local (verified)" means an existing
doc or commit history explicitly labels it as such, "fork-local (likely)" means it was added in this fork and has not
been observed upstream, and "present in this fork" means no upstream comparison has been made.

## Credential Proxy

- **Status:** fork-local (verified)
- **Code:** [`src/credential-proxy.ts`](../src/credential-proxy.ts), wired in `src/index.ts:16` and used in
  `src/container-runner.ts:31`.
- **Docs:** [`docs/credential-proxy.md`](credential-proxy.md) (the canonical reference; line 1 explicitly states
  "Status: fork-local feature, not in upstream NanoClaw").
- **Configuration:** `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in `.env`; `CREDENTIAL_PROXY_PORT` (default
  `3001`) via `src/config.ts:50`.

The credential proxy is a small HTTP reverse proxy that sits between containerised agents and `api.anthropic.com`.
Containers are pointed at it via `ANTHROPIC_BASE_URL` and only ever hold placeholder credentials; the proxy injects
the real `x-api-key` (API-key mode) or OAuth Bearer token (subscription mode) on the wire. The Claude Agent SDK is
unmodified — only the base URL differs from its perspective. The motivation, threat model, and OAuth exchange flow
are covered in full in `docs/credential-proxy.md`.

## Journal MCP Integration

- **Status:** fork-local (likely)
- **Code:** conditional MCP server in
  [`container/agent-runner/src/index.ts:410-420`](../container/agent-runner/src/index.ts); env-var pass-through in
  [`src/container-runner.ts:314-330`](../src/container-runner.ts).
- **Docs:** referenced in [`CLAUDE.md`](../CLAUDE.md) under "Conditional MCP Servers".
- **Configuration:** `JOURNAL_MCP_URL` (the HTTP MCP endpoint) and optional `JOURNAL_API_TOKEN` (sent as
  `Authorization: Bearer <token>`) in `.env`. Tools are exposed to the agent as `mcp__journal__*`.

When `JOURNAL_MCP_URL` is set in `.env`, agent containers register an additional HTTP MCP server that exposes journal
search, ingestion, mood-trend, and entity-extraction tools. The integration is gated entirely on the env var; if it
is absent, the MCP server block is omitted from the SDK options. Bearer-token auth is also conditional on
`JOURNAL_API_TOKEN` being set. This is a personal-deployment integration with a private journal service running on
the user's home network; the upstream tree has no equivalent.

## Sender Allowlist

> **Canonical reference for this feature.** REQUIREMENTS / SPEC / SECURITY summarise; this section owns the details.

- **Status:** fork-local (verified — added in commit `4de981b`, PR #705 on this fork)
- **Code:** [`src/sender-allowlist.ts`](../src/sender-allowlist.ts); consumed in `src/index.ts` via the
  `loadSenderAllowlist` import — search the file for that identifier (currently used at the channel-message,
  trigger-check, group-listing, and task-scheduler call sites; line numbers drift).
- **Summarised in:** [`docs/REQUIREMENTS.md`](REQUIREMENTS.md#sender-allowlist), [`docs/SPEC.md`](SPEC.md) §2 components
  table, and [`docs/SECURITY.md`](SECURITY.md) architecture diagram.
- **Configuration:** `~/.config/nanoclaw/sender-allowlist.json` (path defined in `src/config.ts:30`).

### File format

```json
{
  "default": { "allow": "*", "mode": "trigger" },
  "447700123456@s.whatsapp.net": { "allow": ["447712345678@s.whatsapp.net"], "mode": "trigger" },
  "C0123456789": { "allow": ["U0AAAAA", "U0BBBBB"], "mode": "drop" }
}
```

### Semantics

- **Keying is per-chat** (`chatJid`), not per-channel. The same sender can be allowlisted in one Slack channel and
  denied in another.
- `allow`: `"*"` permits any sender; an array restricts to the listed sender ids.
- `mode`:
  - `"trigger"` — denied senders cannot activate the agent (their messages are still stored in the DB for context).
  - `"drop"` — denied senders' messages are discarded entirely.
- `default` — applied to any chat that has no explicit rule. Without a `default` entry, an unlisted chat defaults
  to `{ allow: "*", mode: "trigger" }` so behaviour is unchanged for installations that haven't opted in.

### Motivation

Defence against a compromised channel key. Even if an attacker gains write access to a Slack workspace or
WhatsApp linked-device, they cannot use that access to talk to the agent unless their sender id is on the
allowlist for that chat. The agent's outbound capabilities (Gmail, Calendar, scheduled tasks) make hijacking
worth defending against in depth.

## Mount Security

- **Status:** fork-local (likely — extensive security hardening not present in upstream's mount handling)
- **Code:** [`src/mount-security.ts`](../src/mount-security.ts); referenced from `src/container-runner.ts` via
  `validateAdditionalMounts()`.
- **Docs:** [`docs/SECURITY.md`](SECURITY.md), section "Mount Security".
- **Configuration:** `~/.config/nanoclaw/mount-allowlist.json` (path defined in `src/config.ts:24`).

Additional mounts requested via a group's `containerConfig.additionalMounts` are validated against an allowlist
stored outside the project root, so containers cannot edit their own permissions. Validation includes `realpath`
resolution (to defeat symlink escapes), a default blocked-pattern list covering credential dotfiles (`.ssh`,
`.gnupg`, `.aws`, `.gcloud`, `.kube`, `.docker`, `.env`, `.netrc`, `.npmrc`, `id_rsa`, `id_ed25519`, etc.), and a
colon-injection guard on container paths to prevent Docker `-v` option smuggling (e.g. `repo:rw`). The
`nonMainReadOnly` flag forces non-main groups to read-only mounts even when their config requests read-write. If the
allowlist file is missing or malformed, all additional mounts are blocked rather than silently allowed.

## WhatsApp Bundled in Core

- **Status:** bundled-vs-upstream-separated
- **Code:** [`src/channels/whatsapp.ts`](../src/channels/whatsapp.ts), [`src/whatsapp-auth.ts`](../src/whatsapp-auth.ts),
  and `@whiskeysockets/baileys` as a top-level dependency in `package.json:23`.
- **Docs:** [`CLAUDE.md`](../CLAUDE.md) "Troubleshooting → WhatsApp not connecting after upgrade" and
  [`docs/REQUIREMENTS.md`](REQUIREMENTS.md) integration-points table.
- **Configuration:** standard WhatsApp env vars (`ASSISTANT_HAS_OWN_NUMBER`, pairing-code auth flow).

Per `CLAUDE.md`, upstream NanoClaw v2 moved the WhatsApp channel out of core and into a separate
`nanoclaw-whatsapp` branch/remote, installable via the `/add-whatsapp` skill. This fork keeps WhatsApp bundled in
`main`: the channel source, auth helpers, and baileys dependency all live in the default tree, and a fresh clone has
WhatsApp available without applying a skill. The trade-off is that pulling upstream changes requires the
rebase-and-merge dance described in `docs/skills-as-branches.md` rather than a clean fast-forward.

## Discord (Skill-Only, Not Bundled)

- **Status:** skill-only
- **Code:** none in `src/` — `src/channels/discord.ts` does not exist. The Discord-enabling skill lives at
  [`.claude/skills/add-discord/SKILL.md`](../.claude/skills/add-discord/SKILL.md).
- **Docs:** the skill's own `SKILL.md`.
- **Configuration:** applied via the `/add-discord` skill, which adds the channel source and dependencies on demand.

Discord is mentioned in the `CLAUDE.md` channel list and is available as a self-registering channel skill, but the
default branch contains no Discord source code and no `discord.js` dependency in `package.json`. This is the inverse
of the WhatsApp situation: upstream may or may not bundle Discord, but in this fork it is strictly opt-in via the
skill. Listing it here is for completeness — anyone scanning the channels directory will not see Discord and might
otherwise assume it is missing rather than deferred.

## Status Tracker

- **Status:** present in this fork
- **Code:** [`src/status-tracker.ts`](../src/status-tracker.ts); persistence at `src/status-tracker.ts:67-72`
  (`path.join(DATA_DIR, 'status-tracker.json')`).
- **Docs:** [`docs/slack-attachments.md`](slack-attachments.md) §"Channel Typing Indicators" is the canonical
  cross-channel reference; `CLAUDE.md` and `SPEC.md` carry one-line pointers.
- **Configuration:** none; gated automatically per the rules in slack-attachments.md.

The status tracker sends progressive emoji reactions (received → thinking → working → done → failed) to the
originating message so the user can see the agent's state on channels that lack a native typing indicator. State
persists to `data/status-tracker.json` across restarts so progress reactions don't get orphaned on a service
reload. The gating rules (main-group + `hasNativeTyping` flag) are owned by
[slack-attachments.md](slack-attachments.md).

## Contributing to Upstream

Anything in this doc that should flow back to upstream needs to take the skill-branch route, not a direct merge from
this `main`. The fork's `main` has cherry-picks and customisations that aren't appropriate for upstream, and a
backflow PR built off `main` would carry them along. The rule is: rebase the contribution onto upstream `main`,
extract just the relevant commits, and open the PR from a clean branch. The general mechanics — including why
skill branches are always rebased onto current `main` rather than merged — are covered in
[`docs/skills-as-branches.md`](skills-as-branches.md) and the matching runbook
[`runbooks/upstream-sync.md`](../runbooks/upstream-sync.md). The same hygiene applies in reverse when pulling
upstream into this fork: rebase first, never let a stale branch carry a missing DB migration or schema-version bump
back over the top of `main`.
