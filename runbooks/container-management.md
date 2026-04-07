# Container Management

NanoClaw spawns ephemeral Docker containers for each agent interaction. Containers are short-lived (minutes), isolated,
and automatically cleaned up.

## Container Lifecycle

1. Message arrives → group queue schedules container
2. `docker run` with mounts, env vars, resource limits
3. Agent-runner inside container receives prompt via stdin JSON
4. Claude SDK processes query, streams output via stdout
5. Additional outputs (send_message, send_blocks) go through IPC files
6. Container exits when query completes or times out (30 min)

## Viewing Running Containers

```bash
# List active NanoClaw containers
docker ps --filter "name=nanoclaw-"

# Resource usage
docker stats --no-stream --filter "name=nanoclaw-"

# Logs from a specific container
docker logs nanoclaw-<group>-<id>
```

## Killing Stuck Containers

If a container has been running for more than 30 minutes, it's likely stuck:

```bash
# Find old containers
docker ps --filter "name=nanoclaw-" --format '{{.Names}} {{.RunningFor}}'

# Kill a specific container
docker stop -t 1 nanoclaw-<name>

# Kill all NanoClaw containers
docker ps --filter "name=nanoclaw-" -q | xargs -r docker stop -t 1
```

The host process also cleans up orphaned containers on startup.

## Building the Container Image

```bash
./container/build.sh
```

This builds `nanoclaw-agent:latest`. The image includes:

- Node.js 22 (slim)
- Chromium + fonts (for agent-browser)
- Poppler (PDF tools)
- Claude Agent SDK + MCP SDK
- Agent-runner TypeScript (pre-compiled)

### When to Rebuild

- After updating `container/Dockerfile`
- After updating `container/agent-runner/package.json` (new dependencies)
- After updating system-level dependencies

### When You Don't Need to Rebuild

- After changing `container/agent-runner/src/` — the source is synced into containers on every spawn via a bind mount
  (`data/sessions/{group}/agent-runner-src`). The entrypoint recompiles TypeScript at runtime.

### Cache Gotcha

Docker's BuildKit caches aggressively. `--no-cache` alone doesn't invalidate COPY steps. For a truly clean rebuild:

```bash
docker builder prune
./container/build.sh
```

## Resource Limits

Defaults (configurable via `.env`):

| Setting        | Default | Env Var                     |
| -------------- | ------- | --------------------------- |
| Memory         | 2g      | `CONTAINER_MEMORY_LIMIT`    |
| CPU            | 2       | `CONTAINER_CPU_LIMIT`       |
| Max concurrent | 5       | `MAX_CONCURRENT_CONTAINERS` |
| Timeout        | 30 min  | `CONTAINER_TIMEOUT` (ms)    |
| Max output     | 10 MB   | `CONTAINER_MAX_OUTPUT_SIZE` |

**Memory planning:** With defaults, 5 concurrent containers need up to 10GB RAM. Adjust based on available host memory.

## Mount Structure

### Main Agent Container

| Container Path             | Host Path                                 | Access               |
| -------------------------- | ----------------------------------------- | -------------------- |
| `/workspace/project`       | Project root                              | Read-only            |
| `/workspace/project/.env`  | `/dev/null`                               | Read-only (shadowed) |
| `/workspace/project/store` | `store/`                                  | Read-write           |
| `/workspace/group`         | `groups/{folder}/`                        | Read-write           |
| `/workspace/global`        | `groups/global/`                          | Read-write           |
| IPC dirs                   | `data/ipc/{group}/`                       | Read-write           |
| Session dir                | `data/sessions/{group}/`                  | Read-write           |
| Agent-runner src           | `data/sessions/{group}/agent-runner-src/` | Read-only            |

### Non-Main Agent Container

| Container Path      | Host Path                                 | Access     |
| ------------------- | ----------------------------------------- | ---------- |
| `/workspace/group`  | `groups/{folder}/`                        | Read-write |
| `/workspace/global` | `groups/global/`                          | Read-only  |
| IPC dirs            | `data/ipc/{group}/`                       | Read-write |
| Session dir         | `data/sessions/{group}/`                  | Read-write |
| Agent-runner src    | `data/sessions/{group}/agent-runner-src/` | Read-only  |

### Additional Mounts

Groups can have additional mounts configured in `registered_groups.container_config`:

```json
{
  "additionalMounts": [{ "hostPath": "/srv/apps/nanoclaw/journal", "containerPath": "journal", "readonly": false }]
}
```

Additional mounts are validated against an allowlist at `~/.config/nanoclaw/mount-allowlist.json`.

## Networking

Containers use host networking for API calls. The credential proxy is accessible at:

| Platform  | Proxy Address                                |
| --------- | -------------------------------------------- |
| Linux     | Docker bridge IP (usually `172.17.0.1:3001`) |
| macOS/WSL | `host.docker.internal:3001`                  |
| Custom    | Set `CREDENTIAL_PROXY_HOST` env var          |

## Container Naming

Containers are named `nanoclaw-{group}-{timestamp}`. The group name comes from the registered group's folder. This makes
it easy to identify which group a container belongs to.

## Debugging Inside a Container

To inspect a running container:

```bash
docker exec -it nanoclaw-<name> /bin/bash
```

To run a one-off container with the same mounts (useful for debugging):

```bash
docker run -it --rm \
  -v /path/to/nanoclaw/groups/slack_test:/workspace/group \
  nanoclaw-agent:latest /bin/bash
```
