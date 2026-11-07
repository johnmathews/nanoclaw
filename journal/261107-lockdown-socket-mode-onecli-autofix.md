# 1. Lockdown, Slack Socket Mode, OneCLI auto-fix, and the log-rotation PR

Date: 2026-11-07. Five follow-ups from the 2026-11-07 design review with the git-maintenance agent, run as an `/engineering-team` session. Run artifacts are in `.engineering-team/runs/manual-20261107T135509Z/` (gitignored).

## 1.1 OneCLI selective-mode papercut (§9), `1234ca8d`

New agent groups used to get 401s, because OneCLI 1.42 creates unknown agents in `selective` secret mode with no secrets. `ensureAgentWithSecretMode` in `src/gateway-providers/onecli.ts` replaces the SDK's `ensureAgent`.
- It calls `createAgent`. A 409 means the agent already exists, and then nothing is done.
- Only for a new agent does it run `onecli agents set-secret-mode --mode all`.

It deliberately does not run on every session: Paul Graham Essays is scoped `selective` on purpose. The patch is in both `src/` and the add-onecli payload, and `onecli-fork.test.ts` guards both.
- **Live check:** a throwaway group wired to `cli/local` answered on its first message.
- **Gotcha:** a top-level `promisify(execFile)` broke 9 unrelated suites. Their `child_process` mocks have no `execFile`, and they import the provider transitively.

## 1.2 Iron Proxy evaluation: no-go

Memo: `iron-proxy-memo.md` in the run dir. Reasons:
- Iron grants go to one principal for the whole install, so per-group scoping is lost.
- Its build is pinned to OneCLI 1.42 anyway.
- There is no vault import.
- The gmail, gcal, tavily, dial and vercel skills only work with OneCLI.

The main motivation was a web console, and OneCLI already has one at `:10254`.

## 1.3 Inbound lockdown (§3, §12), `9ff34dca`

Requirement: "the service or slack app shouldn't be public or open." The only humans are John and Ritsya.
- **Who gets through:** Ritsya was added as a member of job-search-ritsya. All 16 Slack and WhatsApp messaging groups were moved to `decline_notify`. `cli/local` stays `public`, because its socket is mode 0600. An audit of past senders found no legitimate non-member.
- **Network:** the webhook server bound `0.0.0.0:3000` and so was reachable from the LAN. A new `WEBHOOK_HOST` setting (fork default `127.0.0.1`) fixes that. Tailscale Funnel still reached it through loopback.
- **Checked:** the LAN connection is refused, the Funnel returns 401, and a Slack round-trip works.
- Upstream later adopted the same loopback default, so the fork patch can be dropped at the next update.
- Ritsya's live test was skipped: she isn't using NanoClaw at the moment.

## 1.4 Slack Socket Mode (§6), `059313b4`

The existing app token already had `connections:write`. After John enabled Socket Mode in the app, `SLACK_APP_TOKEN` was uncommented in `.env` (by sed, never printed) and the service restarted.
- The log shows `Slack socket mode connected`.
- An introspection canary was routed and answered within 5 seconds.

**Open:** after a few stable days, John turns off the Funnel (`sudo tailscale funnel --https=443 off`). Approval-card button clicks over the socket haven't been explicitly exercised yet.

## 1.5 Log rotation upstreamed: nanocoai/nanoclaw#4291

Upstream accepts features only as skills, so `ops/logrotate` was rebuilt as `/add-log-rotation`. It refers to upstream issue #3916.
- **What it is:** a script with `install`, `uninstall`, `status` and `render-*` commands.
- **Naming:** each install's timer is named after its service unit (`nanoclaw-v2-<slug>`), so several copies on one machine don't collide.
- **Root:** a user-level install needs none; root installs get system units.
- **Test:** a vitest file guards upstream's append-mode unit paths and the install-slug name, and runs a real logrotate pass while a writer holds the file open.
- **Checked:** a real systemd install, re-run and uninstall on this host.
- **Where:** pushed as branch `feat/host-log-rotation` on the fork. This install keeps its own `ops/logrotate` timer for now.

## 1.6 Housekeeping

- New rule from John: run CI on the host, not on GitHub, unless it's essential (cost). Commits pushed to the fork get `[skip ci]`.
- Full local suite: 3915 tests passing. tsc is clean, and the eslint warnings were all there before this session.
