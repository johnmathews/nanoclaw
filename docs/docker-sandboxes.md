# Running NanoClaw in Docker Sandboxes (advanced)

A guide for running NanoClaw inside a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) on macOS or Windows
WSL, giving you **two layers of isolation**: per-agent containers, plus a micro-VM around the entire NanoClaw process.

> **This is an advanced setup.** For most users, [SECURITY.md](SECURITY.md) describes the default isolation
> (containers + credential proxy) which is already strong. Use this only if you want hypervisor-level isolation around
> the whole stack and are willing to maintain the patches below.
>
> **On macOS, prefer [Apple Container](https://github.com/apple/container)** via the `/convert-to-apple-container`
> skill if your goal is per-container VM isolation. Apple Container is native, doesn't require nested Docker, and
> the credential proxy works without any of the patches in this guide.

## Two proxies — don't confuse them

This guide introduces a **second** proxy. Be precise about which is which:

| Proxy                       | Where             | Purpose                                                |
| --------------------------- | ----------------- | ------------------------------------------------------ |
| Docker Sandbox MITM proxy   | `host.docker.internal:3128` (sandbox) | Network egress + cert inspection for the sandbox VM. Replaces `proxy-managed` placeholders. |
| NanoClaw credential proxy   | `localhost:3001` (host)               | Injects Anthropic OAuth/API-key credentials into SDK traffic. Bound to docker0 on Linux. See [SECURITY.md §5](SECURITY.md#5-credential-isolation-credential-proxy). |

In this guide, NanoClaw's credential proxy still runs inside the sandbox, and its **upstream** connection to
`api.anthropic.com` is routed through Docker Sandbox's MITM proxy. The patch in §4e is what wires them together.

## Architecture

```
Host (macOS / Windows WSL)
└── Docker Sandbox (micro VM with isolated kernel)
    ├── NanoClaw host process (Node.js)
    │   ├── Channels
    │   ├── Credential proxy ── routes upstream via sandbox HTTPS_PROXY
    │   └── Container spawner → nested Docker daemon
    └── Docker-in-Docker (DinD)
        └── nanoclaw-agent containers
            └── Claude Agent SDK ── points at credential proxy
```

> **Patch freshness.** The patches in §4 were validated against an earlier version of NanoClaw. They aren't in
> upstream, so you have to apply them yourself. The shape of the code has shifted since then — treat the snippets
> below as **directional**, not literal. If a patch doesn't apply cleanly, the comment in `src/container-runner.ts`
> around the `.env` shadow mount (`container-runner.ts:100-107`) and the upstream-request site in
> `src/credential-proxy.ts:82-94` are the right places to look.

## Prerequisites

- **Docker Desktop v4.40+** with Sandbox support
- **Anthropic credentials** — either an API key (`ANTHROPIC_API_KEY`) or a Max subscription OAuth token
  (`CLAUDE_CODE_OAUTH_TOKEN`). The credential proxy auto-detects which.
- Channel-specific setup (Slack bot token, WhatsApp phone, etc.)

Verify sandbox support:
```bash
docker sandbox version
```

## Step 1: Create the Sandbox

```bash
mkdir -p ~/nanoclaw-workspace
docker sandbox create shell ~/nanoclaw-workspace
```

If you're using WhatsApp, configure proxy bypass so WhatsApp's Noise protocol isn't MITM-inspected:

```bash
docker sandbox network proxy shell-nanoclaw-workspace \
  --bypass-host web.whatsapp.com \
  --bypass-host "*.whatsapp.com" \
  --bypass-host "*.whatsapp.net"
```

Telegram and Slack do not need proxy bypass.

Enter the sandbox:
```bash
docker sandbox run shell-nanoclaw-workspace
```

## Step 2: Install Prerequisites (inside sandbox)

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
npm config set strict-ssl false
```

## Step 3: Clone and Install

NanoClaw must live inside the workspace directory — Docker-in-Docker can only bind-mount from the shared workspace
path.

```bash
# Clone to home first (virtiofs can corrupt git pack files during clone)
cd ~
git clone https://github.com/qwibitai/nanoclaw.git

WORKSPACE=/Users/you/nanoclaw-workspace  # replace with YOUR host workspace path

mv nanoclaw "$WORKSPACE/nanoclaw"
cd "$WORKSPACE/nanoclaw"

npm install
npm install https-proxy-agent
```

## Step 4: Apply Sandbox-Specific Patches

These patches are not in upstream — you apply them yourself. They handle proxy routing, CA certificates, and DinD
mount restrictions.

### 4a. Dockerfile — proxy build args

`npm install` inside `docker build` fails with `SELF_SIGNED_CERT_IN_CHAIN` because the sandbox's MITM proxy presents
its own cert. Add to `container/Dockerfile` after the `FROM` line:

```dockerfile
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NODE_EXTRA_CA_CERTS
ARG npm_config_strict_ssl=true
RUN npm config set strict-ssl ${npm_config_strict_ssl}
```

And after the `RUN npm install` line, re-enable strict-ssl for runtime:

```dockerfile
RUN npm config set strict-ssl true
```

### 4b. Build script — forward proxy args

Patch `container/build.sh` to pass proxy env vars to `docker build`:

```bash
--build-arg http_proxy="${http_proxy:-$HTTP_PROXY}" \
--build-arg https_proxy="${https_proxy:-$HTTPS_PROXY}" \
--build-arg no_proxy="${no_proxy:-$NO_PROXY}" \
--build-arg npm_config_strict_ssl=false \
```

### 4c. Container runner — empty-file shadow, proxy passthrough, CA cert

Three changes in `src/container-runner.ts`:

**Replace `/dev/null` shadow mount.** Docker Sandbox rejects `/dev/null` bind mounts. Around `container-runner.ts:100-107`
where `.env` is shadow-mounted, substitute an empty regular file:

```typescript
const emptyEnvPath = path.join(DATA_DIR, 'empty-env');
if (!fs.existsSync(emptyEnvPath)) fs.writeFileSync(emptyEnvPath, '');
// then mount emptyEnvPath instead of '/dev/null'
```

**Forward proxy env vars** to spawned agent containers. Add `-e` flags for `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`
and the lowercase variants in the container spawn args (~line 290).

**Mount CA certificate.** If `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` is set, copy the cert into a project-internal
directory and mount it read-only:

```typescript
const caCertSrc = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
if (caCertSrc) {
  const certDir = path.join(DATA_DIR, 'ca-cert');
  fs.mkdirSync(certDir, { recursive: true });
  fs.copyFileSync(caCertSrc, path.join(certDir, 'proxy-ca.crt'));
  // mount certDir → /workspace/ca-cert (ro); set NODE_EXTRA_CA_CERTS in container env
}
```

### 4d. Container runtime — don't kill the sandbox

In `src/container-runtime.ts`, `cleanupOrphans()` matches containers by the `nanoclaw-` prefix. Inside a sandbox,
the sandbox container itself may match (e.g. `nanoclaw-docker-sandbox`). Filter out `os.hostname()` from the list of
containers to stop.

### 4e. Credential proxy — route upstream through sandbox MITM

In `src/credential-proxy.ts` (the upstream `makeRequest()` call around line 82), wrap the outbound request with
`HttpsProxyAgent`:

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const upstreamAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
// pass `agent: upstreamAgent` in the makeRequest() options
```

### 4f. Setup script — proxy build args

Patch `setup/container.ts` to pass the same proxy `--build-arg` flags as `build.sh`.

## Step 5: Build

```bash
npm run build
bash container/build.sh
```

## Step 6: Add a Channel

Channels are now installed by adding a git remote and merging — there is no `scripts/apply-skill.ts` anymore.

### Slack (recommended — no extra proxy patches)

```bash
git remote add slack https://github.com/qwibitai/nanoclaw-slack.git
git fetch slack main
git merge slack/main
npm run build
```

Configure `.env`:

```bash
cat > .env << EOF
SLACK_BOT_TOKEN=<xoxb-...>
SLACK_APP_TOKEN=<xapp-...>      # Socket Mode app-level token
ASSISTANT_NAME=nanoclaw
# Use whichever auth mode applies. Container ships with a placeholder.
ANTHROPIC_API_KEY=proxy-managed
# or, for Max subscription:
# CLAUDE_CODE_OAUTH_TOKEN=proxy-managed
EOF
```

### WhatsApp (requires extra proxy patches)

Make sure you configured proxy bypass in [Step 1](#step-1-create-the-sandbox) first.

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
git fetch whatsapp main
git merge whatsapp/main
npm run build
```

The WhatsApp skill files (`src/channels/whatsapp.ts` and `src/whatsapp-auth.ts`) need their own proxy patches:
`HttpsProxyAgent` for the WebSocket transport, and a proxy-aware `fetchWaVersionViaProxy` for version negotiation.

Configure `.env` and re-pair:

```bash
cat > .env << EOF
ASSISTANT_NAME=nanoclaw
ANTHROPIC_API_KEY=proxy-managed
EOF

npm run auth --pairing-code --phone <number-no-plus>
```

### Telegram

```bash
git remote add telegram https://github.com/qwibitai/nanoclaw-telegram.git
git fetch telegram main
git merge telegram/main
npm run build
```

Patch `src/channels/telegram.ts` to pass `HttpsProxyAgent` to grammy's `Bot` constructor via `baseFetchConfig.agent`.

## Step 7: Run

```bash
npm start
```

## Networking Details

### How the two proxies interact

```
Agent container → credential proxy (localhost:3001 inside sandbox)
                       ↓ (with HttpsProxyAgent patch from §4e)
                  Sandbox MITM proxy (host.docker.internal:3128)
                       ↓
                  Host → api.anthropic.com
```

The credential proxy still does its job: it injects the real `ANTHROPIC_API_KEY` or OAuth Bearer on the appropriate
requests. The new piece is that the proxy's **outbound** connection now goes through the sandbox MITM rather than
straight to Anthropic.

**"Bypass" does not mean traffic skips the proxy.** It means the proxy passes traffic through without MITM
inspection — used for WhatsApp's Noise protocol which can't be inspected.

### Why `proxy-managed` works as a placeholder

`ANTHROPIC_API_KEY=proxy-managed` in `.env` looks like a real value, but the credential proxy doesn't actually
forward it to Anthropic. It strips the placeholder and substitutes whichever credential mode it detected at startup
(your real key from the host environment, or an OAuth token via the exchange dance). Same idea applies if you set
`CLAUDE_CODE_OAUTH_TOKEN=proxy-managed`.

### Shared paths for DinD mounts

Only the workspace directory is available for Docker-in-Docker bind mounts:

- `/dev/null` → replace with an empty file in the project dir (§4c)
- `/usr/local/share/ca-certificates/` → copy cert to project dir (§4c)
- `/home/agent/` → clone NanoClaw to the workspace instead

### Git clone and virtiofs

The workspace is mounted via virtiofs. Git's pack file handling can corrupt over virtiofs during clone. Workaround:
clone to `/home/agent` first, then `mv` into the workspace.

## Troubleshooting

| Symptom                              | Cause / fix                                                             |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `SELF_SIGNED_CERT_IN_CHAIN`          | `npm config set strict-ssl false` for install; rebuild image with §4a   |
| "path not shared" on agent spawn     | All bind mounts must be under the workspace dir; check NanoClaw is cloned there, CA cert copied, empty `.env` shadow exists |
| Agent can't reach `api.anthropic.com`| Verify proxy env vars are forwarded to agent containers (§4c); credential-proxy patch (§4e) applied |
| Sandbox container killed on startup  | `cleanupOrphans()` matched the sandbox; apply §4d                       |
| WhatsApp error 405                   | Stale version. Apply `fetchWaVersionViaProxy` patch                     |
| WhatsApp "Connection failed" immediately | Proxy bypass not configured. From the **host**: `docker sandbox network proxy <sandbox-name> --bypass-host web.whatsapp.com --bypass-host "*.whatsapp.com" --bypass-host "*.whatsapp.net"` |
| Telegram bot doesn't receive         | grammy proxy patch missing; check `HttpsProxyAgent` in `src/channels/telegram.ts`; disable Group Privacy in @BotFather |
| Git clone "inflate: data stream error" | virtiofs corruption — clone to `~`, then `mv` into workspace          |
| WhatsApp QR code doesn't display     | Run auth command interactively inside the sandbox: `docker sandbox run shell-nanoclaw-workspace` then `npm run auth --pairing-code --phone <number>` |

## See Also

- [SECURITY.md](SECURITY.md) — the default trust model (containers + credential proxy) without sandboxes
- [runbooks/container-management.md](../runbooks/container-management.md) — operational container ops
- [`/convert-to-apple-container` skill](../.claude/skills/convert-to-apple-container/SKILL.md) — simpler macOS-native alternative
