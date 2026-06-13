# Paywall-bypass browser for research agents

Give a research agent group a headless Chromium that loads the
**Bypass Paywalls Clean** extension, so `agent-browser` reads paywalled
articles for summarization. Built on per-group container `env` (migration 019)
plus the mount allowlist — no code changes per group, no shared browser service.

## How it works

`agent-browser` (baked into the agent image) supports extensions natively:
`--extension` / `AGENT_BROWSER_EXTENSIONS`, a persistent `--profile` /
`AGENT_BROWSER_PROFILE`, and launch args via `AGENT_BROWSER_ARGS`. We supply
all three as **container env vars** so every `agent-browser` invocation in the
group transparently loads the extension — the agent never has to remember flags.

Two non-obvious facts (verified against the live image):

1. **Loading an extension forces Chromium into headed mode**, which dies in a
   container with `Missing X server or $DISPLAY`. The fix is **`--headless=new`**
   (Chromium's new headless supports extensions) — passed via `AGENT_BROWSER_ARGS`.
   No Xvfb needed.
2. **The extension can be mounted read-only.** Chromium writes only into the
   profile dir, never the extension dir. So the Syncthing-synced copy stays
   auto-updating and the mount is `:ro`.

The three env vars:

| Var | Value | Why |
|-----|-------|-----|
| `AGENT_BROWSER_EXTENSIONS` | `/workspace/extra/bpc` | the RO-mounted extension |
| `AGENT_BROWSER_PROFILE` | `/workspace/agent/.bpc-profile` | persistent context (required for extensions); under the group dir so cookies/login survive restarts |
| `AGENT_BROWSER_ARGS` | `--no-sandbox,--headless=new` | new headless + sandbox off (container runtime) |

Reserved env keys (`TZ`, `HOME`, `*PROXY*`, cert vars) are rejected by
`set-env` and filtered by the container runner, so this can never reroute the
agent's API traffic around the OneCLI credential proxy.

## One-time host setup

Add the extension dir to the mount allowlist
(`~/.config/nanoclaw/mount-allowlist.json`), read-only:

```json
{
  "path": "/srv/apps/syncthing/all/bypass-paywalls-chrome-clean-master",
  "allowReadWrite": false,
  "description": "Bypass Paywalls Clean extension (RO)"
}
```

## Per research group

`GROUP` is the agent-group id (e.g. the HN summaries group, or a new FT group).

```bash
# 1. Mount the extension at /workspace/extra/bpc.
#    No ncl verb for additional_mounts yet — set the DB column directly.
#    NOTE: this REPLACES additional_mounts; merge by hand if the group has others.
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs SET \
  additional_mounts='[{\"hostPath\":\"/srv/apps/syncthing/all/bypass-paywalls-chrome-clean-master\",\"containerPath\":\"bpc\",\"readonly\":true}]' \
  WHERE agent_group_id='$GROUP'"

# 2. Set the three browser env vars.
ncl groups config set-env --id "$GROUP" --json \
  '{"AGENT_BROWSER_EXTENSIONS":"/workspace/extra/bpc","AGENT_BROWSER_PROFILE":"/workspace/agent/.bpc-profile","AGENT_BROWSER_ARGS":"--no-sandbox,--headless=new"}'

# 3. Apply (re-materializes container.json + respawns).
ncl groups restart --id "$GROUP"
```

Verify from inside the group's container that the extension service worker is
live (the BPC service worker is `chrome-extension://lkbebcjgcmobigpeffafkodonchffocl/background.js`).

## Caveat

The extension is third-party JavaScript running in the browser context and
auto-updates via Syncthing. Fine for a personal research box; it is an
unreviewed code path that refreshes itself.
