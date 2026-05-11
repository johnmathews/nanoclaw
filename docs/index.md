# NanoClaw Documentation

Technical documentation for the NanoClaw project. If you're new, start with [REQUIREMENTS.md](REQUIREMENTS.md) for
philosophy, then [SPEC.md](SPEC.md) for the system. For day-to-day operations and troubleshooting, go straight to
[../runbooks/](../runbooks/).

## Architecture & Reference

| Document                                          | When to read                                                |
| ------------------------------------------------- | ----------------------------------------------------------- |
| [REQUIREMENTS.md](REQUIREMENTS.md)                | Why NanoClaw exists, philosophy, design constraints         |
| [SPEC.md](SPEC.md)                                | Technical reference: components, data flows, env vars, DB schema |
| [SECURITY.md](SECURITY.md)                        | Trust model, container isolation                            |
| [credential-proxy.md](credential-proxy.md)        | How OAuth/API-key auth is injected; design, internals, strengths, weaknesses, how to improve. Reference for building similar tools. |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)              | How `@anthropic-ai/claude-agent-sdk` works internally       |
| [skills-as-branches.md](skills-as-branches.md)    | How skills are distributed (git branches and remotes)       |
| [SLACK-ATTACHMENTS.md](SLACK-ATTACHMENTS.md)      | Slack-specific behavior: attachments, threads, reactions    |
| [docker-sandboxes.md](docker-sandboxes.md)        | Advanced: extra hypervisor isolation via Docker Sandboxes   |

## Operations & Runbooks

For everything operational, see [../runbooks/](../runbooks/):

| Runbook                                                          | Purpose                                          |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| [architecture-overview.md](../runbooks/architecture-overview.md) | Quick-reference architecture diagram             |
| [service-management.md](../runbooks/service-management.md)       | systemd / launchd start, stop, restart           |
| [container-management.md](../runbooks/container-management.md)   | Container operations, image rebuild, mount paths |
| [channel-operations.md](../runbooks/channel-operations.md)       | Channel-specific operational notes               |
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

If you find this doc set saying something the code doesn't, the doc is wrong — patch it. If you find a runbook
saying something the code doesn't, the runbook is wrong — patch it. There is no separate spec to defer to.
