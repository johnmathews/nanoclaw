# NanoClaw Documentation

The index for everything under `docs/`. Find the right reference and jump straight to it. If you're new to the
project, the suggested reading order is [REQUIREMENTS.md](REQUIREMENTS.md) (philosophy) → [SPEC.md](SPEC.md)
(technical reference) → the relevant topical doc below. For day-to-day operations,
[../runbooks/troubleshooting.md](../runbooks/troubleshooting.md) is usually the right entry point.

## Architecture & Reference

| Document                                          | When to read                                                |
| ------------------------------------------------- | ----------------------------------------------------------- |
| [REQUIREMENTS.md](REQUIREMENTS.md)                | Why NanoClaw exists, philosophy, design constraints         |
| [SPEC.md](SPEC.md)                                | Technical reference: components, data flows, env vars, DB schema |
| [SECURITY.md](SECURITY.md)                        | Trust model, container isolation                            |
| [credential-proxy.md](credential-proxy.md)        | OAuth/API-key injection at the network boundary; subscription-vs-API-key billing routing; canonical reference |
| [claude-subscription-auth.md](claude-subscription-auth.md) | How to set up Claude Pro/Max subscription billing in a different tool: SDK packages, setup token, headers, policy boundary |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)              | How `@anthropic-ai/claude-agent-sdk` works internally       |
| [skills-as-branches.md](skills-as-branches.md)    | How skills are distributed (git branches and remotes)       |
| [slack-attachments.md](slack-attachments.md)      | Slack attachments + threads + reactions; canonical for channel typing indicators |
| [slash-commands.md](slash-commands.md)            | Full reference for every slash command (host / agent-runner / SDK split, auth model) |
| [fork-divergence.md](fork-divergence.md)          | What this fork ships on top of upstream `qwibitai/nanoclaw`; canonical for sender allowlist |
| [docker-sandboxes.md](docker-sandboxes.md)        | Advanced: extra hypervisor isolation via Docker Sandboxes   |

### Filename conventions

- **Uppercase** filenames (`REQUIREMENTS.md`, `SPEC.md`, `SECURITY.md`, `SDK_DEEP_DIVE.md`) mark **canonical
  specifications**. These docs describe the system rather than a single feature.
- **lowercase-with-hyphens** filenames (`credential-proxy.md`, `slack-attachments.md`, `slash-commands.md`,
  `fork-divergence.md`, `skills-as-branches.md`, `docker-sandboxes.md`) mark **topical references** — one feature
  or surface area each.

This is intentional convention, not pending migration. New topical docs should follow the lowercase pattern.

## Active Migrations

In-flight cross-cutting work that spans many sessions. Read these before doing anything related to the migration's scope.

| Document                                                                              | Status                                                                                       |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [v2-migration/motivation-and-context.md](v2-migration/motivation-and-context.md)      | active (planning, 2026-05-21) — why we're migrating from v1 to v2, decisions, alternatives rejected |
| [v2-migration/implementation-plan.md](v2-migration/implementation-plan.md)            | active (planning, 2026-05-21) — phased step-by-step plan (P0–P8) with rollback per work unit |

## Operations & Runbooks

For everything operational, see [../runbooks/](../runbooks/):

| Runbook                                                          | Purpose                                          |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| [architecture-overview.md](../runbooks/architecture-overview.md) | Quick-reference architecture diagram             |
| [service-management.md](../runbooks/service-management.md)       | systemd / launchd start, stop, restart           |
| [container-management.md](../runbooks/container-management.md)   | Container operations, image rebuild, mount paths |
| [channel-operations.md](../runbooks/channel-operations.md)       | Channel-specific operational notes               |
| [re-auth.md](../runbooks/re-auth.md)                             | Re-authenticating WhatsApp / Gmail / GCal / Slack |
| [database-operations.md](../runbooks/database-operations.md)     | SQLite access patterns, migrations               |
| [health-monitoring.md](../runbooks/health-monitoring.md)         | `/health`, `/status`, watchdog                   |
| [troubleshooting.md](../runbooks/troubleshooting.md)             | Symptom-based debugging                          |
| [upstream-sync.md](../runbooks/upstream-sync.md)                 | Cherry-pick and merge workflow                   |

## Decision Journal

Why decisions were made — the irreplaceable context that isn't visible in code or git history. See
[../journal/](../journal/) (`README.md` explains the format). A few high-signal entries:

- [260511-add-credential-proxy-oauth.md](../journal/260511-add-credential-proxy-oauth.md) — Credential proxy and Max-subscription OAuth (fork-local)
- [260420-journal-token-and-whatsapp-isolation.md](../journal/260420-journal-token-and-whatsapp-isolation.md) — Bearer auth for journal MCP; WhatsApp failure containment
- [260401-slack-thread-support.md](../journal/260401-slack-thread-support.md) — Slack threads
- [260326-health-monitoring-system.md](../journal/260326-health-monitoring-system.md) — Health + watchdog design
- [260331-upstream-cherrypick-breakage.md](../journal/260331-upstream-cherrypick-breakage.md) — Cherry-pick safety rules

## Authority

When sources disagree, the order is:

1. **Code** (under `src/`, `container/agent-runner/src/`)
2. **CLAUDE.md** (this fork's canonical operational summary)
3. **Runbooks** (`/runbooks/`)
4. **This `/docs/` set**
5. **Journal entries** (frozen-in-time decisions)

**Topic-canonical exceptions.** Some `/docs/` files explicitly own a topic. For these, the named doc wins over the
corresponding section of CLAUDE.md when they disagree:

| Topic                                  | Canonical reference                                                       |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Slash commands (host/runner/SDK split) | [slash-commands.md](slash-commands.md)                                    |
| Slack attachments, threads, reactions  | [slack-attachments.md](slack-attachments.md)                              |
| Channel typing indicators (all channels) | [slack-attachments.md §Channel Typing Indicators](slack-attachments.md#channel-typing-indicators) |
| Credential proxy internals             | [credential-proxy.md](credential-proxy.md)                                |
| Sender allowlist format and semantics  | [fork-divergence.md §Sender Allowlist](fork-divergence.md#sender-allowlist) |
| Fork-vs-upstream divergence index      | [fork-divergence.md](fork-divergence.md)                                  |

If you find this doc set saying something the code doesn't, the doc is wrong — patch it. If you find a runbook
saying something the code doesn't, the runbook is wrong — patch it. There is no separate spec to defer to.

To find all line-cited claims in this doc set (useful when source moves), run:

```bash
grep -rn 'src/[a-z-]*\.ts:[0-9]' docs/
```
