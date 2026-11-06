# Paywall-bypass browser for research agents

**Status:** live config, extension source broken. **Last verified:** 2026-11-06
against the live install: the Financial Times and HackerNews Summaries groups
carry the env vars below, but the extension directory they mount was deleted
with Syncthing on 2026-10-23, so every spawn logs `Additional mount REJECTED`
and runs without it (`docs/operational-gotchas.md` item 38). The steps below
still use the old path. Swap in the extension's new location once it has one.

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
   profile dir, never the extension dir. So the mount is `:ro`, and the copy
   on the host can be updated in place. Until 2026-10-23 Syncthing kept it
   current; that sync is gone.

The three env vars:

| Var | Value | Why |
|-----|-------|-----|
| `AGENT_BROWSER_EXTENSIONS` | `/workspace/extra/bpc` | the RO-mounted extension |
| `AGENT_BROWSER_PROFILE` | `/workspace/agent/.bpc-profile` | persistent context (required for extensions); under the group dir so cookies/login survive restarts |
| `AGENT_BROWSER_ARGS` | `--no-sandbox,--headless=new` | new headless + sandbox off (container runtime) |

Reserved env keys are rejected by `set-env` and filtered by the container
runner, so this can never reroute the agent's API traffic around the OneCLI
credential proxy: `TZ`, `HOME`, the container-network proxy vars
(`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`/`FTP_PROXY`), and cert-bundle
vars (`NODE_EXTRA_CA_CERTS`, `*CURL_CA*`, `*REQUESTS_CA*`, `SSL_CERT_*`). These
are matched by **exact name**, not substring — so namespaced tool vars like
`AGENT_BROWSER_PROXY` stay settable (see "Hard sites & proxies" below).

## Hard sites & proxies

The BPC extension bypasses many paywalls directly, but the hardest ones don't
yield to it. **Test per site** before assuming direct bypass works — open a real
article and confirm the body renders, not a teaser or a challenge page.

- **FT (ft.com)** is the canonical hard case (verified 2026-06-13): BPC's direct
  method fails (it falls back to suggesting archive.today), and the Googlebot-UA
  trick returns a `403` (FT verifies Googlebot by IP). The working route is to
  read article bodies via **archive.today** (`https://archive.ph/newest/<url>`)
  while using the site's own front page only for headline/URL discovery. A
  realistic `AGENT_BROWSER_USER_AGENT` (not the default "HeadlessChrome") plus
  `--disable-blink-features=AutomationControlled` in `AGENT_BROWSER_ARGS` keeps
  those pages loading without tripping bot detection.
- **IP blocks** (a site or archive mirror blocking this server's datacenter IP)
  are the case for a proxy. Route the **browser** — not the whole container —
  through a VPN/residential proxy with `AGENT_BROWSER_PROXY`
  (`ncl groups config set-env --id <group> --key AGENT_BROWSER_PROXY --value "http://user:pass@host:port"`).
  It only affects in-tool browsing, never the OneCLI credential path, which is
  why it's allowlisted while `HTTP(S)_PROXY` are not.

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
# 1. Mount the extension at /workspace/extra/bpc (operator-only verb; it
#    adds to additional_mounts rather than replacing them).
#    To move an existing mount, `config remove-mount` the old one first.
ncl groups config add-mount --id "$GROUP" \
  --host /srv/apps/syncthing/all/bypass-paywalls-chrome-clean-master \
  --container bpc --ro

# 2. Set the three browser env vars.
ncl groups config set-env --id "$GROUP" --json \
  '{"AGENT_BROWSER_EXTENSIONS":"/workspace/extra/bpc","AGENT_BROWSER_PROFILE":"/workspace/agent/.bpc-profile","AGENT_BROWSER_ARGS":"--no-sandbox,--headless=new"}'

# 3. Apply (re-materializes container.json + respawns).
ncl groups restart --id "$GROUP"
```

Verify from inside the group's container that the extension service worker is
live (the BPC service worker is `chrome-extension://lkbebcjgcmobigpeffafkodonchffocl/background.js`).

## Caveat

The extension is third-party JavaScript running in the browser context. It
used to auto-update via Syncthing, an unreviewed code path that refreshed
itself. Fine for a personal research box. Whatever replaces Syncthing as its
source decides whether that is still true.
