# 2026-06-13 — Per-group container env + paywall-bypass browser for research agents

## What changed

Two things, one enabling the other:

1. **New feature: per-group container `env`.** `container_configs` gains an
   `env` JSON column (migration 019). Operators set arbitrary environment
   variables that the container runner injects as `docker run -e` flags at
   spawn time. Set via `ncl groups config set-env` / `unset-env`.

2. **Use case: a headless Chromium that loads the Bypass Paywalls Clean
   extension**, available to research agent groups (HN summaries now; a series
   of new research channels — FT etc. — to follow). Built entirely on (1) plus
   the existing mount allowlist. See `docs/research-paywall-browser.md`.

## Why

John is researching automation + summarization and wants agents to read
paywalled articles. The agent image already ships `agent-browser` (Playwright
over system Chromium), which has first-class extension support
(`--extension` / `AGENT_BROWSER_EXTENSIONS`, `--profile`, `AGENT_BROWSER_ARGS`).
So the problem was never "build a browser" — it was "get the extension + the
right launch flags into the container without patching anything."

Per-container (not a shared sidecar) was the right architecture: it fits
NanoClaw's on-demand one-browser-per-container model, keeps isolation intact,
and needs no shared Docker network or CDP exposure. A shared browser only wins
if you want shared logged-in sessions, at the cost of concurrency contention
and full-control CDP exposure.

The env vars *could* have been hardcoded somewhere, but a general per-group
`env` map is the sturdy, reusable answer: every new research group opts in with
the same three vars, and the agent can't forget a flag because the env is
always present.

## Verified empirically (against the live image, before writing code)

- `agent-browser` 0.27.0 supports `--extension`/`AGENT_BROWSER_EXTENSIONS`,
  `--profile`, `AGENT_BROWSER_ARGS`, `connect`/CDP.
- Loading an extension forces Chromium **headed** → dies with
  `Missing X server or $DISPLAY` in a container.
- **`--headless=new` fixes it** — extension's MV3 service worker
  (`chrome-extension://lkbebcjgcmobigpeffafkodonchffocl/background.js`) loads
  and runs. No Xvfb.
- The extension loads fine from a **read-only** mount (Chromium writes only
  into the profile dir).
- The pure **env-var-only** path (no flags) works — which is exactly what the
  new `config.env` injects.

## How

- `019-container-config-env.ts`: `ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'`.
- `container-config.ts`: `ContainerConfig.env`; `configFromDb` parses it;
  new pure helpers `isReservedContainerEnv` + `containerEnvArgs` (shared by CLI
  and runner, unit-tested).
- `container-runner.ts`: injects `containerEnvArgs(containerConfig.env)` after
  provider env, **before** OneCLI/host-gateway/user-mapping — so on any residual
  key collision the later privileged `-e` wins (docker last-value-wins).
- Reserved keys (`TZ`, `HOME`, `*PROXY*`, cert vars) are filtered at injection
  and rejected by `set-env`, so per-group env can never reroute API traffic
  around the OneCLI credential proxy.
- `groups.ts`: `config set-env` (--key/--value or --json) and `config unset-env`.
- Tests: env round-trip (`container-configs.test.ts`) + reserved-key filtering
  (`container-config.test.ts`). Full host suite green (502).

## Gotcha for go-live

The live `data/v2.db` has no `env` column until the host restarts and runs
migration 019. So: restart the service first (runs the migration), *then* set
the HN group's mount + env, *then* `ncl groups restart` that group. Setting env
before the service restart fails ("no such column: env").
