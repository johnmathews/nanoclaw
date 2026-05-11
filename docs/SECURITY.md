# NanoClaw Security Model

This document describes the security boundaries and trust model. For day-to-day operations see
[runbooks/container-management.md](../runbooks/container-management.md) and
[runbooks/architecture-overview.md](../runbooks/architecture-overview.md).

## Trust Model

| Entity                | Trust level | Rationale                                          |
| --------------------- | ----------- | -------------------------------------------------- |
| Main group            | Trusted     | Private self-chat, admin control                   |
| Direct-conversation groups (`requiresTrigger=false`) | Trusted | All senders treated as the owner; same auth as main for session commands |
| Other registered groups | Semi-trusted | Trigger-gated, but senders may be third parties |
| Container agents      | Sandboxed   | OS-level isolation, no host credentials            |
| Inbound channel messages | User input | Potential prompt injection                       |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in OS-isolated containers:

- **Linux + Docker** — process and namespace isolation (cgroups, network, pid, mount namespaces). Not a VM, but enough to prevent agents from affecting the host.
- **macOS + Docker Desktop** — Linux VM hosting Docker; everything inside the VM is namespace-isolated as on Linux.
- **macOS + Apple Container** — per-container lightweight VM via the `/convert-to-apple-container` skill (separate branch). True VM-per-container isolation.

Common properties across runtimes:

- **Non-root execution** — agent runs as unprivileged `node` user (uid 1000)
- **Ephemeral** — `--rm` removes the container on exit; nothing persists outside mounted volumes
- **Resource limits** — `--memory 2g --cpus 2` by default (override via `CONTAINER_MEMORY_LIMIT` / `CONTAINER_CPU_LIMIT`). Caps DoS blast radius if an agent loops or allocates aggressively.
- **No new privileges** — container can't acquire capabilities beyond what the daemon grants at start
  (enforced via `--security-opt no-new-privileges`; see `src/container-runner.ts:347`)

This is the primary security boundary. Permission checks at the application layer are defense in depth; the OS sandbox is what actually prevents a compromised agent from touching the host.

### 2. Mount Security

Mount permissions live in an **external allowlist** at `~/.config/nanoclaw/mount-allowlist.json`. The file is outside the project root, never mounted into any container, and not editable by agents.

#### Allowlist file format

```json
{
  "allowedRoots": [
    { "path": "~/projects",       "allowReadWrite": true,  "description": "Development projects" },
    { "path": "~/repos",          "allowReadWrite": true,  "description": "Git repositories" },
    { "path": "~/Documents/work", "allowReadWrite": false, "description": "Work documents (read-only)" }
  ],
  "blockedPatterns": ["password", "secret", "token"],
  "nonMainReadOnly": true
}
```

- `allowedRoots[].path` — host paths a mount can resolve to (after symlink resolution). Mounts that resolve outside any allowed root are rejected.
- `blockedPatterns` — substrings matched against the resolved host path. These extend the always-on defaults
  (see `DEFAULT_BLOCKED_PATTERNS` in `src/mount-security.ts:23-41` for the authoritative list — at time of writing:
  `.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker, credentials, .env, .netrc, .npmrc, .pypirc, id_rsa,
  id_ed25519, private_key, .secret`).
- `nonMainReadOnly` — when true, non-main groups get read-only mounts regardless of the group's `containerConfig.additionalMounts` settings.

Implementation: `src/mount-security.ts`. Generate a template via `generateAllowlistTemplate()`.

#### Active protections

- **Symlink resolution before validation** — `realpath` is run on the host path before allowlist matching, so a symlink in an allowed root pointing at `/etc` is rejected.
- **Container-path injection guard** — container paths containing `:` are rejected (`mount-security.ts:213-216`) to prevent `-v` argument injection (e.g. `-v /allowed:/safe:ro,/etc:/etc:rw`).
- **Container path validation** — rejects `..` and absolute paths from group configs.
- **Read-only project root** — main group's project root is mounted `ro`. Writable paths the agent needs (`store/`, group folder, IPC, `.claude/`) are mounted separately. Prevents an agent from modifying host application code (`src/`, `dist/`, `package.json`).
- **`.env` shadowed** — `.env` in the project root is shadow-mounted with `/dev/null` so even if a tool tried to read it via the mounted project root it would see an empty file (`container-runner.ts:100-107`). Apple Container can't mount `/dev/null`; the [`/convert-to-apple-container` skill](../.claude/skills/convert-to-apple-container/SKILL.md) uses an empty regular file as the shadow.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:

- Groups cannot see other groups' conversation history
- Session data includes full message history and any file contents the agent read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation                   | Main group | Non-main group |
| --------------------------- | ---------- | -------------- |
| Send message to own chat    | ✓          | ✓              |
| Send message to other chats | ✓          | ✗              |
| Schedule task for self      | ✓          | ✓              |
| Schedule task for others    | ✓          | ✗              |
| View all tasks              | ✓          | Own only       |
| Manage other groups         | ✓          | ✗              |
| Set `isMain` via IPC        | ✗          | ✗              |

**Re-registration safety:** When `register_group` targets an already-registered group (e.g. to update mounts), the
two privilege flags are handled asymmetrically (`src/ipc.ts:545-553`):

- `isMain` is **always preserved** from the existing registration; the payload's value is ignored. A non-main group
  cannot elevate to main via re-registration.
- `requiresTrigger` is **only preserved when the payload omits it** (the code uses
  `data.requiresTrigger ?? existing?.requiresTrigger`). An explicit value in the re-register payload wins. Don't
  rely on this as a defence-in-depth property; trigger requirement *can* be downgraded by a re-register call.

**Session-modifying commands** (`/compact`, `/clear`, `/done`) require admin access: main group, `is_from_me`, or `requiresTrigger=false` groups. Read-only commands (`/usage`, `/model`, `/skills`, `/status`) are available to any sender.

### 5. Credential Isolation (Credential Proxy)

The host runs a local HTTP proxy ([`src/credential-proxy.ts`](../src/credential-proxy.ts)) that injects Anthropic
credentials at the network boundary. Containers are pointed at it via
`ANTHROPIC_BASE_URL=http://<host-gateway>:3001` and ship with placeholder credentials only.

Two modes:

- **API-key mode** — host has `ANTHROPIC_API_KEY`; proxy injects `x-api-key` on every request.
- **OAuth mode** — host has `CLAUDE_CODE_OAUTH_TOKEN` (Max subscription); proxy injects the OAuth Bearer **only**
  on the SDK's exchange request to `/api/oauth/claude_cli/create_api_key`. Anthropic returns a short-lived API key
  the SDK uses for everything else; the proxy passes those through unchanged.

**Trust impact, honestly framed:**

- Long-lived credentials (real API key, OAuth refresh/access tokens) never enter the container.
- Short-lived exchange-derived API keys *do* live in container memory and go out on every request. A compromised
  agent could exfiltrate the temp key (limited blast radius), but never the long-lived OAuth token behind it.

On bare-metal Linux the proxy binds to the **`docker0` bridge IP** so non-container host processes can't reach it
and use it as a credential-laundering relay. macOS and WSL bind to `127.0.0.1` (Docker Desktop VM routing already
isolates the loopback).

For full design, request-flow diagrams, implementation walkthrough, strengths/weaknesses, and improvement ideas,
see **[credential-proxy.md](credential-proxy.md)**.

### 6. MCP Server Credentials

A non-obvious cross-cutting concern: always-on MCP servers ship with host credentials mounted into **every** group
container, including non-main groups (`container-runner.ts:204-223`):

| MCP server      | Mount                                       | Implication                                      |
| --------------- | ------------------------------------------- | ------------------------------------------------ |
| Gmail           | `~/.gmail-mcp/` → `/home/node/.gmail-mcp/`  | Any group can read/send mail on the host account |
| Google Calendar | `~/.config/google-calendar-mcp/` → same     | Any group can read/write the host's calendars    |

If you don't want non-main groups talking to Gmail/Calendar, either disable those MCP servers or remove the
`mcp__gmail__*` / `mcp__google-calendar__*` allowed-tools entries from the agent-runner's tool config for those
groups.

Conditional MCP servers (`docs`, `journal`, `parallel-search`) are HTTP-based and authenticate with an env-var token
the proxy injects; they don't have a filesystem credential mount problem.

## Privilege Comparison

| Capability          | Main group                        | Non-main group           |
| ------------------- | --------------------------------- | ------------------------ |
| Project root access | `/workspace/project` (ro)         | None                     |
| Store (SQLite DB)   | `/workspace/project/store` (rw)   | None                     |
| Group folder        | `/workspace/group` (rw)           | `/workspace/group` (rw)  |
| Global memory       | Implicit via project              | `/workspace/global` (ro) |
| Additional mounts   | Configurable, rw                  | Read-only unless allowlist overrides |
| Network access      | Unrestricted                      | Unrestricted             |
| MCP tools           | All                               | All — including host Gmail/Calendar (see §6) |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Inbound channel messages (potentially malicious / injection)     │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, sender allowlist
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Credential proxy on docker0:3001 (OAuth/API key)               │
│  • Container lifecycle                                            │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts, placeholder creds
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution as uid 1000                                    │
│  • Bash, file ops limited to mounted paths                        │
│  • Outbound API via proxy; only sees short-lived exchange key     │
│  • No long-lived credentials in env, fs, or stdin                 │
│  • Memory/CPU capped (2g/2cpu default)                            │
└──────────────────────────────────────────────────────────────────┘
```

## Related Documents

- [runbooks/container-management.md](../runbooks/container-management.md) — operational container ops
- [runbooks/architecture-overview.md](../runbooks/architecture-overview.md) — system architecture
- [journal/260511-add-credential-proxy-oauth.md](../journal/260511-add-credential-proxy-oauth.md) — design rationale and known limitations of the credential proxy
- [docs/docker-sandboxes.md](docker-sandboxes.md) — optional nested-isolation via Docker Sandboxes
