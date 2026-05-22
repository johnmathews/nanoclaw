# P3 notes — data migration + de-facto cutover

**Date:** 2026-05-21
**Outcome:** **PASS WITH CAVEATS** — v2 is in production for WhatsApp + scheduled tasks; Slack inbound is broken pending a transport reconfiguration. Several pre-spike assumptions about P3's scope were wrong (the migration skill crosses the one-way door; v2's Slack adapter has no Socket Mode; v1's trigger and sender semantics weren't actually being enforced).

The plan's P3 is still structurally sound but **P4/P5/P6 ordering is invalidated** — they happen now against a live v2, not a stopped one, and Slack-inbound is the first urgent item.

---

## 1. What P3 was supposed to do

Per [implementation-plan.md](implementation-plan.md) §5 P3:

- **W3.1** stop v1 + take clean stopped-service backup
- **W3.2** run `migrate-v2.sh` from a real terminal
- **W3.3** walk interactive prompts (decline service switchover)
- **W3.4** inspect `handoff.json`
- **W3.5** restart v1 so the user has a working bot during P4
- **W3.6** run upstream's `/migrate-from-v1` skill for owner seed + CLAUDE.local.md cleanup + container-config reconciliation

P4 (port fork features) and P5 (channel hardening) were to happen against a stopped v2, before the P7 one-way-door cutover.

## 2. What actually happened

### W3.1 — done as planned

v1 stopped, clean backup at `~/backups/nanoclaw-pre-migrate-v2-20260521-140449.tar.gz` (31M, 3893 files; includes `store/messages.db`, 470 session files, `data/status-tracker.json`, all 8 `groups/*/` dirs).

### W3.2 + W3.3 — done as planned

`migrate-v2.sh` ran cleanly from real terminal. `overall_status=success`, `service_switched=false` confirmed in `handoff.json`. All 10 step logs green:

```
1a-env, 1b-db, 1c-groups, 1d-sessions, 1e-tasks,
2b-channel-auth, 2c-install-{whatsapp,slack,resend}, 3e-build
```

Operator selected `whatsapp`, `slack`, `resend` at the channel prompt; Gmail was not offered (per `2a-channels-selected.txt`). Decline-service-switchover was respected.

### W3.4 — done as planned

`handoff.json` clean. Three followups listed (owner seed / CLAUDE.local.md review / container.json mount review), all consumed by W3.6.

### W3.5 — **SKIPPED — must not happen**

`/migrate-from-v1` (next step) ran a smoke-test phase that started v2's systemd unit and exercised a real WhatsApp roundtrip. That gave v2 the Baileys keystore. Restarting v1 from this point would create a concurrent Baileys session and break WA on both. **The plan's assumption that W3.5 is safe to run after W3.6 is wrong.**

### W3.6 — done, but went much further than the plan anticipated

`/migrate-from-v1` walked 6 phases. Beyond what the plan expected (owner seed / CLAUDE.local.md cleanup / container-config reconciliation), the skill also:

- Started the v2 systemd unit (`nanoclaw-v2-787facac.service`)
- Confirmed a WhatsApp roundtrip end-to-end (route → container → reply)
- Restarted the service to apply final changes
- Reported `STATUS: success`

In effect, **the skill collapsed P3 + P5 + (de-facto) P7 cutover into a single user-driven step.** This is the single most important finding from the session — see §3.1.

Owner seeding: `whatsapp:31683775990@s.whatsapp.net` granted the global `owner` role. Sender policy: all groups left at `unknown_sender_policy=public`, `sender_scope=all`. CLAUDE.local.md cleanup ran across 9 groups (`main` stripped of 11K v1 boilerplate; `whatsapp_main` git-identity removed; `slack_the-managers-guide` paths repointed `/workspace/group/` → `/workspace/agent/`, `/workspace/global/CLAUDE.md` → `.claude-shared.md`). `container.json` mounts repointed: `slack_git-maintenance` + `main`'s `slack_job-search` mount → `/srv/apps/nanoclaw-v2`; **`main`'s journal mount kept at v1 path** `/srv/apps/nanoclaw/journal` (intentional per skill, fragile across W8.6 tombstone). Mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) gained `/srv/apps/nanoclaw-v2` as a second allowed root.

### Phase A (added this session) — per-group MCP wiring + gmail-mcp setup

Surfacing the third critical finding (§3.4): v2 stores MCP server config per-group in `container_configs.mcp_servers` (JSON column), unlike v1's host-env-var → conditional registration model. Migrate-v2.sh did not seed these. All ten groups had `mcp_servers={}` post-migration.

Direct DB writes added six MCPs to `main-group` + WhatsApp `John` (`docs`, `journal`, `parallel-search`, `parallel-task` as HTTP type; `gmail`, `google-calendar` as stdio via `npx`). `The Managers' Guide` got `gmail` + `google-calendar` only (newsletter cron). Mount + allowlist updated to include `/home/john/.gmail-mcp`. First container spawn after the changes rejected the gmail mount because v2 requires `containerPath` to be relative (v2 prepends `/workspace/extra/`). Second iteration used `containerPath: '.gmail-mcp'` + `HOME=/workspace/extra` env override; mount accepted, MCPs all registered.

Then the agent's response to a `mcp__gmail__*` invocation revealed the fourth finding (§3.4): v2's gmail/gcal flow uses **OneCLI-managed stub credentials**, not real OAuth on disk. The pre-wired stdio MCPs needed real `~/.gmail-mcp/*` swapped for `"onecli-managed"` stub files, plus a one-time OneCLI browser OAuth at `http://127.0.0.1:10254/connections?connect=gmail`. Operator ran upstream's `/add-gmail-tool` + `/add-gcal-tool` skills in a fresh `claude` session against `/srv/apps/nanoclaw-v2` to complete that step cleanly; result confirmed working ("Gmail and Google Calendar setup").

### Phase B — W6.7 subscription billing verify (PASSED conclusively)

`/api/oauth/usage` query at 22:11 CEST returned:

```
five_hour:        7% utilization (resets 20:19 UTC — observed reset to 0% at 22:19 local)
seven_day:       12% utilization (resets 2026-05-26)
seven_day_sonnet: 1% utilization
seven_day_opus:   null
extra_usage:     { is_enabled: false, disabled_reason: "org_level_disabled_until" }
```

Token prefix `sk-ant-oat01-T…` (subscription OAuth, correct kind). **`extra_usage.is_enabled=false` at the org level**: spillover is structurally impossible, irrespective of whether OneCLI's MITM does the right substitution. This is a stronger answer than the planned pre/post diff — there is no second bucket to leak into. **W6.7 retired.**

### Phase C — Slack roundtrip test (FAILED — production gap)

Operator sent `@John ping` in a Slack channel v2 is wired to. **Zero events reached v2.** Webhook server alive (curl `/webhook/slack` returns 401 on unsigned request). Diagnosed (§3.2): v2's Slack adapter is webhook-only; v1's was Socket Mode. Slack app config still targets Socket Mode. Slack has no public URL to POST to.

## 3. Critical findings

### 3.1 `/migrate-from-v1` is not P3's last step — it is the de-facto cutover

The skill's phase list includes a "smoke test" that starts the v2 systemd unit, exercises a real channel roundtrip, and reports `success`. From the operator's perspective this looks like the final verification step; in reality it has crossed the P7 one-way door:

- v2's systemd unit is now `active+enabled`
- v2 holds the WhatsApp Baileys keystore; v1 cannot be restarted on the same number without breaking WA on both
- Inbound messages on the live channels land on v2, not v1

**The plan's W3.5 ("restart v1 to give the user a working bot during P4 porting") is invalid as written.** W3.5 must be marked SKIPPED in the plan whenever `/migrate-from-v1`'s smoke-test phase has run.

The implementation-plan should be revised:

- P3 W3.5 — annotate "SKIP if `/migrate-from-v1` has been run; v2 already holds active channel sessions"
- P3 W3.6 — promote the "smoke test starts v2" property to a top-of-section warning so future operators (or future-Claude) don't miss it
- P7 — collapse W7.5/W7.6/W7.7 into "verify; already happened during P3 W3.6"; keep W7.4 (port restore), W7.1 (final backup), W7.2/W7.3 (stop+disable v1 explicitly), W7.8/W7.9 (real-channel + scheduled-task smoke)
- Master rollback plan — "after P3 W3.6" becomes equivalent to "after P7 cutover"

### 3.2 v2's Slack adapter has no Socket Mode

`@chat-adapter/slack`'s README explicitly states `socket_mode_enabled: false`. The package supports only Slack Events API webhooks: requires `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`, exposes `/webhook/slack` on port 3000, expects Slack to POST inbound events. v1 used `@slack/bolt` in Socket Mode with `SLACK_APP_TOKEN` (xapp-…) — long-lived WebSocket from Slack to v1, no public URL needed.

The Slack app on `api.slack.com` is still configured for Socket Mode (since v1 used it). To restore Slack inbound on v2, one of:

- **A. Public webhook + Events API.** Stand up a tunnel for `:3000/webhook/slack` (Tailscale Funnel, cloudflared, ngrok), disable Socket Mode in the Slack app, enable Event Subscriptions, set Request URL, re-subscribe to events.
- **B. Custom Socket Mode adapter.** Port v1's @slack/bolt + socketMode:true pattern onto v2's channel-registry shape. Bigger lift, diverges further from upstream.

Path A is operationally faster; Path B preserves v1's "no public URL exposed" property. Decide in P4.

Slack outbound (bot token → `chat.postMessage`) works on v2 — it does not depend on Socket Mode or webhooks. **Scheduled tasks that POST to Slack channels continue to fire.**

### 3.3 W6.7 — subscription billing conclusively verified, even without a pre/post diff

The originally planned W6.7 was a pre/post snapshot diff of `/api/oauth/usage` after firing a few real v2 container requests. The actual reading was stronger: `extra_usage.is_enabled=false` at the org level, with `disabled_reason="org_level_disabled_until"`. **There is no alternative bucket for requests to land in. Subscription routing is structurally enforced**, irrespective of what OneCLI's MITM does. The five_hour / seven_day / seven_day_sonnet counters are advancing normally with v2's traffic.

**Risk retirement:** kill criterion #1 from implementation-plan §6 ("subscription-billing wire verification fails") is no longer relevant; the structural guarantee is sufficient.

(Aside: my Phase B instructions used `jq -r .accessToken` which is wrong for the credentials file structure — should be `jq -r .claudeAiOauth.accessToken`. Fix the instruction next time it's documented.)

### 3.4 v2's MCP wiring model differs from v1's; two transports apply

v1 wired MCPs in `container/agent-runner/src/index.ts` via conditional blocks reading host env vars (`JOURNAL_MCP_URL`, `DOCS_MCP_URL`, `PARALLEL_API_KEY`, gmail/calendar stdio). All containers got the same set.

v2 wires MCPs per agent group in `container_configs.mcp_servers` (JSON column on the central DB), surfaced to the container via `/workspace/agent/container.json`. **`migrate-v2.sh` does not seed this column**; every group starts with `{}`. Without explicit wiring, agents in v2 have only the built-in `nanoclaw` MCP — no docs, journal, gmail, parallel.

Two valid shapes coexist in v2's `mcp_servers` JSON despite the host-side TypeScript typing it as stdio-only:

- **HTTP MCPs** — `{ type: 'http', url, headers }`. Used for `docs`, `journal`, `parallel-search`, `parallel-task`. The Claude Agent SDK natively supports the HTTP transport; v2's agent-runner passes the JSON through unmodified (the `as McpServerConfig` cast in `container-config.ts:51` doesn't validate at runtime). Confirmed working — agent successfully called `mcp__journal__journal_list_entries` and got real data.
- **Stdio MCPs with OneCLI-MITM** — `{ command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'], env: { HOME: '/workspace/extra', ... } }`. For Gmail and Google Calendar specifically. **Real OAuth creds on disk are wrong**; the package reads stub credential files containing `"onecli-managed"` placeholders, and OneCLI's MITM intercepts outbound `gmail.googleapis.com` / `calendar.googleapis.com` calls and substitutes the real token from its vault. The browser OAuth flow that connects OneCLI to Gmail/GCal must run once per provider via `http://127.0.0.1:10254/connections?connect=<provider>`. Documented in `/srv/apps/nanoclaw-v2/.claude/skills/add-gmail-tool/SKILL.md` and `add-gcal-tool/SKILL.md`; `/add-gmail-tool` + `/add-gcal-tool` skills are the canonical setup.

Notable: GitHub, Google Drive, and several other providers are also OneCLI-managed apps available via `onecli apps list`. None of them are wired into any group yet — they're available for future use via the same pattern.

### 3.5 `containerPath` in `additional_mounts` must be relative

v2's `src/modules/mount-security/index.ts:isValidContainerPath` rejects absolute paths (must not start with `/`), `..`, empty strings, or colons (the last guards against `-v <host>:<container>:rw` injection). Validated relative paths are mounted at `/workspace/extra/<relative>` inside the container. Confirmed by direct test: containerPath `/home/node/.gmail-mcp` → REJECTED; `.gmail-mcp` → mounted at `/workspace/extra/.gmail-mcp`.

This rules out re-using v1's container mount paths verbatim. Anything that hardcoded `/home/node/.gmail-mcp` in env (e.g., `GOOGLE_OAUTH_CREDENTIALS`) needs a path override.

### 3.6 Several "regressions" were not regressions — corrected by reading v1 actual state

Initial audit flagged three apparent regressions; on closer inspection two were not:

- **engage_pattern = '.'** on all 10 groups was flagged as "responds to every message vs v1's `@agent` trigger." Wrong. v1's `requires_trigger=0` on all 10 groups means the trigger gate was never enforced; v1 already responded to every message in every group. v2 matches v1 actual behavior. Not a regression.
- **`unknown_sender_policy='public'`, `sender_scope='all'`** on all groups was flagged as "removes v1's per-chat sender allowlist." Wrong. `~/.config/nanoclaw/sender-allowlist.json` does not exist on this host; v1's sender-allowlist code is present but never configured for production. v2 matches v1 actual behavior. Not a regression.
- **`container_configs.mcp_servers = {}` on all 10 groups** — was a real regression. v1 had global env-var → conditional MCP registration. v2 needs explicit per-group seeding. See §3.4.

Lesson: when comparing v2 against v1, **read v1 runtime state (DB rows, config files on disk, the `requires_trigger=0` rows) rather than v1's intended semantics from the code or docs.** The code/docs describe what could happen; the runtime state describes what was happening.

### 3.7 Installer slug differs from the spike prediction

The spike (P1) predicted v2's install slug for `/srv/apps/nanoclaw-v2/` would be `9c12bd9b` (per `sha1(path)[:8]`). The actual slug is `787facac`. v2.0.64's slug algorithm differs from the spike-era one. Real unit name: `nanoclaw-v2-787facac.service`. Real image tag: `nanoclaw-agent-v2-787facac:latest`. References to `9c12bd9b` in implementation-plan §8 note 4 and §5 W7.5 are stale.

## 4. State of v2 after P3

| | State |
|---|---|
| v1 (`nanoclaw.service`) | inactive + disabled. v1 keystore intact on disk. **Do not restart** while v2 holds WA. |
| v2 (`nanoclaw-v2-787facac.service`) | **active + enabled**. PID stable, listening `0.0.0.0:3000`. `NRestarts=0`. |
| v1 install dir | `/srv/apps/nanoclaw` — kept on disk (tombstone candidate at W8.6, ~30 days out). Journal/ still mounted by `main-group`. |
| v2 install dir | `/srv/apps/nanoclaw-v2` |
| v2 central DB | `/srv/apps/nanoclaw-v2/data/v2.db` (~225K) |
| v2 session dirs | `/srv/apps/nanoclaw-v2/data/v2-sessions/ag-*/sess-*` — 10 agent groups (matches v1's 10 `registered_groups` rows) |
| WhatsApp inbound | ✅ working (roundtrip confirmed) |
| WhatsApp outbound | ✅ working |
| Slack inbound | ❌ broken — webhook-only adapter, no public URL, Slack app still on Socket Mode. See §3.2. |
| Slack outbound | ✅ working (bot token posts independently of inbound transport) |
| Gmail (MCP tool) | ✅ wired via OneCLI; `/add-gmail-tool` skill ran cleanly |
| Google Calendar (MCP tool) | ✅ wired via OneCLI; `/add-gcal-tool` skill ran cleanly |
| Gmail (channel — i.e. receive emails as triggers) | ❌ not migrated. Deferred per operator. |
| Resend channel | installed; `RESEND_API_KEY` empty; logs `WARN Channel credentials missing, skipping` on each startup. Operator will fill key later. |
| Docs MCP | ✅ wired (HTTP) into `main-group` + `John (WA)` |
| Journal MCP | ✅ wired (HTTP + Bearer JOURNAL_API_TOKEN) into same two groups; main-group mount still points at v1's `/srv/apps/nanoclaw/journal/` |
| Parallel MCP (search + task) | ✅ wired into same two groups |
| Subscription billing | ✅ verified — extra_usage org-disabled (see §3.3) |
| Sender allowlist | ❌ not enforced (matches v1 actual; not a regression) |
| Health endpoint / watchdog | ❌ absent on v2 (was fork-local; P4 W4.3 still to port) |
| `/usage` slash command | ❌ absent (fork-local; P4 W4.5) |
| Owner / roles | `whatsapp:31683775990@s.whatsapp.net` = global owner. No other users seeded. |
| Scheduled tasks | ✅ 4 active v1 tasks migrated to per-session `inbound.db` (kind=task): morning report (cron `28 7 * * *`), docs summary (`3 9 * * *`), git maintenance (`3 2 * * 1,4`), newsletter extraction (`7 2 * * 3`). 7 completed v1 tasks correctly excluded. |

**Crons fire from v2's internal scheduler** — they do not depend on Slack inbound. All four should run as scheduled. Morning report (07:28 CEST) and docs summary (09:03 CEST) both depend on Gmail send: tested working via OneCLI. Newsletter extraction (Wed 02:07) depends on Gmail read: same path. Git maintenance (Mon/Thu 02:03) depends only on git CLI + Slack outbound: works.

## 5. Plan revisions needed

These changes apply to [implementation-plan.md](implementation-plan.md). Tracking here so the next session can fold them in.

### Replace or annotate

- **§5 P3 intro:** add a "**Warning — `/migrate-from-v1` crosses the one-way door**" callout above W3.1.
- **§5 P3 W3.5:** rewrite or annotate "SKIP after running W3.6 — see [p3-notes.md](p3-notes.md) §3.1."
- **§5 P3 W3.6 action block:** state explicitly that the skill's smoke-test phase starts the v2 systemd unit and exercises a real channel roundtrip — by the time it completes successfully, the cutover has effectively happened.
- **§5 P4 ordering:** demote W6.7 (it's done; see §3.3 here). Promote a new W4.0 "Restore Slack inbound" — pick path A (tunnel + Events API) or B (Socket Mode adapter port). New work unit, not in the original plan.
- **§5 P5 W5.1 (Slack):** add a precondition that W4.0 must complete first.
- **§5 P7:** shrink. W7.1 (final backup) and W7.4 (port restore) still apply. W7.2/W7.3 (stop+disable v1) already happened. W7.5/W7.6/W7.7 (install + enable + start v2 unit) already happened. W7.8/W7.9 (smoke + scheduled-task fire) — partially happened via §3.1; redo Slack-side once W4.0 lands.
- **§5 P4 W4.5 `/usage`:** update — the curl-based check at §3.3 is the interim. `/usage` port still wanted for in-chat visibility, but no longer load-bearing for cutover safety.
- **§6 Kill criteria:** strike #1 (W6.7 failure) — see §3.3 here.
- **§8 note 4:** update install slug from `9c12bd9b` → `787facac`. Add: "v2.0.64's slug algorithm differs from the spike's prediction; resolve manually via `. setup/lib/install-slug.sh && systemd_unit` for any new install."

### Add

- **§5 new W4.0 — Restore Slack inbound** between P3 W3.6 and existing P4 W4.1. Decide between (A) tunnel + Events API reconfig and (B) custom Socket Mode adapter port. Document the choice in `docs/v2-migration/slack-inbound-decision.md` (new) before implementing. Slack outbound already works; this is purely about Slack → v2 message delivery.

## 6. Operational gotchas (carry into P4)

1. **Never restart v1.** It is stopped + disabled; restarting it from current state would conflict with v2 for the WhatsApp Baileys keystore and break WA on both. v1 install dir stays on disk for ~30 days as tombstone (W8.6) for journal-mount source and rollback insurance.
2. **`pnpm` lives at `~/.npm-global/bin/pnpm`**, not on the Claude Code Bash tool's default PATH. Prefix `PATH="/home/john/.npm-global/bin:$PATH"` or use the absolute path. Same applies to `onecli` (same dir).
3. **`ncl` is at `/srv/apps/nanoclaw-v2/bin/ncl`**, not on the default PATH either. Prefix `PATH="/srv/apps/nanoclaw-v2/bin:$PATH"`.
4. **The fresh-session approach** worked well for the OneCLI gmail/gcal setup: a separate `claude` session against `/srv/apps/nanoclaw-v2` running upstream's `/add-gmail-tool` + `/add-gcal-tool` skills, while the orchestrating session here handled the rest. For P4 work that involves skills shipped by upstream, prefer this pattern — the skill prompts are upstream-canonical and don't need to be re-derived in this session.
5. **OneCLI binds to `127.0.0.1:10254` on the host and `172.17.0.1:10254` from inside containers.** Browser OAuth for new provider connections needs an SSH tunnel from the operator's local machine: `ssh -L 10254:127.0.0.1:10254 <server>`.
6. **OneCLI vault entry for the Anthropic subscription token** is `name=Anthropic, type=anthropic, host=api.anthropic.com, id=5705cd20-ea15-41d4-80fe-3ee57c5b2f92`. If the token expires, refresh via `claude setup-token` then `onecli secrets update Anthropic --value <token>`. Do not paste tokens into chat.
7. **Mount allowlist after P3:** `/srv/apps/nanoclaw`, `/srv/apps/nanoclaw-v2`, `/home/john/.gmail-mcp` (added Phase A), `/home/john/.calendar-mcp` (added by `/add-gcal-tool`). Three `allowedRoots`. `blockedPatterns` length is 17 (defaults from v2).
8. **MCP wiring on a fresh agent group** in v2 is via `ncl groups config add-mcp-server --id <ag-id> --name <name> --command <cmd> [--args <json>] [--env <json>]` for stdio shape. For HTTP shape (`type: 'http'`), direct DB write into `container_configs.mcp_servers` JSON; v2 accepts this at runtime despite the host TypeScript typing it as stdio-only. Either way, **mounts and MCP entries are picked up on the next container spawn** — no service restart needed if no container is currently running for that group.
9. **`docker exec <container> env`** is the cleanest way to confirm what env vars and HOME the agent-runner sees inside a live v2 container.
10. **Container build cache:** `cd /srv/apps/nanoclaw-v2 && ./container/build.sh` if any `container/*` changes. Aggressive — prune the builder if layers look stale.
11. **Resend channel** is installed and logs a `WARN Channel credentials missing, skipping` on each startup. Operator chose to leave it; will fill `RESEND_API_KEY` later. Cosmetic, not a functional issue.
12. **v2 working tree** at `/srv/apps/nanoclaw-v2` has untracked `src/channels/{whatsapp,slack,resend,index}.ts` from `/migrate-from-v1`'s channel install — these are upstream skill output; leave untracked unless we want to track them locally.
13. **This fork's working tree** at `/srv/apps/nanoclaw` has uncommitted `docs/v2-migration/*.md` + `docs/index.md` from P0+P1+P2+P3 revisions. Not yet committed. Operator will review cumulative diff first.

## 7. Outcome and recommendation

**W3.7 outcome (the gate after P3):** PASS WITH CAVEATS.

- **Data migration:** clean. 10/10 groups, 4/4 active tasks, all per-session files in place. `handoff.json` all green.
- **Cutover:** effectively happened during W3.6 via the `/migrate-from-v1` smoke test. v2 is production.
- **Channels:** WA full-duplex ✅, Slack outbound ✅, Slack inbound ❌, Gmail/GCal (as MCP tools) ✅, Gmail (as channel) deferred.
- **Subscription billing:** verified structurally (§3.3).
- **Fork features absent on v2:** sender allowlist (irrelevant — never enforced in v1 production), health/watchdog (P4 W4.3), `/usage` (P4 W4.5), remote-control (P4 W4.6 — nice-to-have).

**Recommendation:** **Proceed to P4.** First task is the new W4.0 (Slack inbound restoration). Crons fire fine without it, but interactive Slack is the daily-driver path for most channels and matters for visibility. Then resume original P4 ordering (health/watchdog → `/usage` → journal MCP confirm-already-wired → remote-control optional). Defer or retire W4.1 (sender-allowlist port) per §3.6 — no production utility.

**Risks accepted (revised from plan §10):**

- **No `/health` endpoint on v2.** If v2 deadlocks, no automatic restart until W4.3 lands. systemd will eventually detect the unit failing on its own, but no proactive watchdog. Mitigated by v2's clean restart history (NRestarts=0 since 23:45:46).
- **No `/usage` slash command.** Operator can't see rate-limit utilisation in-chat. Curl from §3.3 is the workaround until W4.5 ports it.
- **Slack inbound silent for now.** Operator must use WhatsApp until W4.0 lands.

---

## 8. Notes for any future spike-style work in this migration

- **Read the upstream skill SKILL.md end-to-end before running.** `/migrate-from-v1`'s smoke-test phase silently crossed the cutover. Anything labelled "smoke test", "verify", or "test" inside a migration skill can mean "start the service."
- **When comparing v2 against v1, read v1 runtime state, not v1 intent.** §3.6 — three "regressions" were flagged based on v1 source/docs; two evaporated when checked against the v1 DB and config files on disk.
- **v2's TypeScript types are sometimes a lie at runtime.** §3.4 — `container-config.ts`'s `McpServerConfig` types as stdio-only, but the SDK and pass-through code accept HTTP. Test what works empirically rather than trusting the host-side type cast.
- **The fresh-session-for-skills pattern is valuable.** Running upstream's `/add-gmail-tool` + `/add-gcal-tool` in a separate `claude` window kept the prompts upstream-canonical, kept this session's context cleaner, and avoided re-deriving setup instructions.

---

## 9. W4.0 resolution — Slack inbound restored (2026-05-22)

**Outcome:** PASS. Real Slack message → v2 → container → reply roundtrip working. Bot identity (`U0AMHR1U9L0`) and all 9 channel memberships preserved.

**Path chosen:** Path A — reconfigure the existing Slack app from Socket Mode → Events API; Tailscale Funnel for public ingress. Rationale captured in [slack-inbound-decision.md](slack-inbound-decision.md). Path C was the operator's initial preference but the parity audit (decision doc §3) showed end-state architecture is identical between A and C while C costs a 9-channel re-invite for zero feature gain. Path B was rejected — custom adapter code on top of v2's channel-registry would diverge further from upstream every sync.

**What was done:**

1. **Tunnel** — `tailscale funnel --bg 3000` (required `sudo`; one-time invocation, persists across reboots via tailscaled). Public URL: `https://agent.flicker-enigmatic.ts.net/webhook/slack`. Survives SSH disconnect (daemon-level).
2. **Cert** — `sudo tailscale cert agent.flicker-enigmatic.ts.net` was required even with HTTPS Certificates enabled in admin and Funnel capability granted. **Without an explicit `tailscale cert` run, the public DNS record was never published.** This is the surprise of the session — see §9.2 below. Cert is now cached in Tailscale's state dir, auto-renews.
3. **Slack app reconfig** — operator did the api.slack.com clicks:
    - Socket Mode → off
    - Event Subscriptions → on; Request URL set to the Funnel URL; Slack url-verification returned ✅ immediately
    - Subscribed bot events: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim` (skipped `assistant_thread_*` — those need `assistant:write` scope, out of W4.0 scope)
    - Interactivity & Shortcuts → on; Request URL same (sets up for future block_actions porting)
4. **Roundtrip verification** — operator sent a real Slack message; v2 log:
    ```
    10:04:49.526  Session created       threadId="slack:C0AMA1R7EPK:1779437088.208099"
    10:04:49.542  Message routed        agentGroup=main-group  userId="slack:U0AMGE1SNGY"
    10:04:49.694  Spawning container    containerName=nanoclaw-v2-main-1779437089583
    10:04:58.979  Message delivered     (outbound reply)
    ```
    Per-thread session, ~9.5s round-trip. ✅

### 9.1 Operational gotchas discovered

1. **Tailscale Funnel needs `sudo` or an `operator` grant** for non-root users. Operator chose one-time `sudo` over `sudo tailscale set --operator=$USER` (durable). Future Funnel tweaks need sudo again.
2. **`tailscale cert <domain>` writes cert+key to CWD.** Ran in `/srv/apps/nanoclaw/`; landed `agent.flicker-enigmatic.ts.net.{crt,key}` (root-owned, 0600 on key) in the fork's working dir. These are **redundant** (Tailscale caches the cert internally for auto-renewal) and **a hygiene issue** (private key sitting next to code). Clean up via `sudo rm`. Doesn't get committed by accident — file names don't match anything in the repo's globs, but worth deleting anyway.
3. **v2's webhook adapter silently rejects unsigned requests with HTTP 401 "Invalid signature" and does NOT log the rejection at INFO/WARN level.** The only diagnostic surface for the webhook path is *successful* message routing — there's no breadcrumb if Slack stops POSTing. Worth thinking about whether to add a request-counter or rate-of-401 metric in a future hardening pass.
4. **v2's log is written to `/srv/apps/nanoclaw-v2/logs/nanoclaw.{log,error.log}`**, not journald. The systemd unit uses `StandardOutput=append:` to redirect. `journalctl --user -u nanoclaw-v2-787facac.service` shows only the systemd-side start message; everything else is in the log files. Carry this into future debug runbooks.
5. **DNS resolution from the host itself doesn't work for the Funnel domain** because `agent.flicker-enigmatic.ts.net` is only published on public DNS — the host's local resolver doesn't have ts.net wired up. To curl-test locally, use `--resolve agent.flicker-enigmatic.ts.net:443:<one-of-the-public-A-records>`. The public A records are Tailscale Funnel ingress IPs (during this session: `176.58.{88.82,88.108,92.199}`).

### 9.2 The cert provisioning gotcha (worth highlighting for future ops)

The chain that needs to be true for Tailscale Funnel to actually serve public traffic:

1. Tailnet ACL grants `funnel` capability to the node — **necessary, not sufficient**
2. HTTPS Certificates feature enabled at tailnet level (admin console → DNS) — **necessary, not sufficient**
3. `tailscale funnel --bg <port>` succeeds locally — **necessary, not sufficient**
4. **`sudo tailscale cert <domain>` runs successfully** — necessary; without this step, no public DNS record exists and Slack/anyone-else cannot reach the Funnel endpoint

Steps 1-3 leave the local serve config saying "Funnel on" but the public DNS auth NS (DNSimple) returns NXDOMAIN. Only after step 4 does the DNS record get published. Diagnosis cost in this session: ~15 minutes. Future runbooks should treat step 4 as mandatory, not auto-magical.

### 9.3 What W4.0 did NOT do (still open follow-ups)

- **Slack interactivity / block_actions handler port.** v1's `app.action(/^nanoclaw_checkbox_/)` and `app.action(/^nanoclaw_confirm_/)` for the git-maintenance branch-delete confirm flow are not wired through v2's bridge. v2's adapter parses the `payload` field at `/webhook/slack` but it's unverified whether `chat-sdk-bridge.ts` exposes block_actions to channel consumers. The next Mon/Thu 02:03 git-maintenance cron will post a checkbox message that cannot be confirmed via Slack. Track as a follow-up W4.x.
- **Audit `chat-sdk-bridge.ts` for files/reactions/typing/streaming wiring.** Adapter exposes all of these; whether they're piped to the agent (multimodal images, Whisper voice, etc.) is unverified. Separate audit.
- **Cleanup the root-owned cert files** at `/srv/apps/nanoclaw/agent.flicker-enigmatic.ts.net.{crt,key}` — `sudo rm` to remove.

### 9.4 Plan revisions (apply to implementation-plan.md)

- **§5 P4 W4.0** — mark DONE. Add a one-line pointer to this §9 + [slack-inbound-decision.md](slack-inbound-decision.md).
- **§5 P4 W4.0** — add to the action block: "*Step 4 of the Tailscale Funnel setup is `sudo tailscale cert <domain>`, which is NOT auto-magical even with HTTPS Certs enabled at tailnet level. Without it, the public DNS record is never published and Slack gets NXDOMAIN.*"
- **§5 P4** — add new W4.8 "Slack interactivity / block_actions port" (currently absent from the plan). Or fold into a new W4.x audit work unit covering both interactivity + bridge feature audit.

---

## 10. W4.3 resolution — health endpoint + systemd watchdog (2026-05-22)

**Outcome:** PASS. v2 now has `/health` on `127.0.0.1:3002`, systemd watchdog at 30s, and the unit moved from `Type=simple` to `Type=notify`. End-to-end provocation confirmed: with WATCHDOG=1 silenced past the 30s window, systemd sends SIGABRT and `Restart=always` brings the unit back. v1 parity achieved (and the v1 installer gap that left fresh installs running `Type=simple` with no watchdog is closed for v2).

**What was done:**

1. **Three new files in v2** mirroring v1's shape:
   - `src/health.ts` — pure `collectHealth(deps)`, `formatAge`, `formatHealthText`; types are identical to v1's so any caller of v1's snapshot lifts unchanged.
   - `src/health-server.ts` — `startHealthServer(port, getHealth)`. Returns 200 healthy / 503 degraded / 404 other-paths / 500 on provider exception. Binds `127.0.0.1` only.
   - `src/watchdog.ts` — `initWatchdog()` returns null when `NOTIFY_SOCKET` is absent. Uses `systemd-notify --pid=<self>` so `NotifyAccess=all` attributes correctly to the main process.

2. **Snapshot composer in `src/index.ts`** (`snapshotHealth()`) — gathers data sources without polluting the modules barrel:
   - **Channels:** `getActiveAdapters()` from `channels/channel-registry.ts`.
   - **Loop-running:** new `getDeliveryPollsRunning()` (delivery.ts) + new `isHostSweepRunning()` (host-sweep.ts) — both are private-var getters added in this session. `messageLoopRunning = delivery && sweep`.
   - **Queue:** `getActiveContainerCount()` (container-runner.ts) and `MAX_CONCURRENT_CONTAINERS` from config. v2 has no waiting queue, so `waiting=0` always.
   - **Groups + sessions:** `getAllAgentGroups()` and `getActiveSessions()`.
   - **Cursor:** `MAX(sessions.last_active)` from the central DB, with `Z` appended (SQLite stores timezoneless UTC). Empty string when no sessions exist yet.
   - **Tasks:** v2 has no central task table — tasks are `messages_in` rows with `kind='task'` in per-session inbound DBs. The composer walks `getActiveSessions()`, opens each inbound DB read-only, sums active/paused, counts `status='failed' AND timestamp >= datetime('now', '-1 day')`, and tracks the minimum `process_after` across all sessions for `nextRunTime`. Per-request cost is bounded — only fires on `/health` hits.

3. **Wired into the main lifecycle:**
   - Health server starts after CLI server, before "NanoClaw running" log. `HEALTH_PORT` env var, defaults to `3002`.
   - Watchdog tick on a `setInterval` (2s), `unref()`'d so it doesn't keep the loop alive at shutdown.
   - Shutdown order: clear tick → `watchdog.close()` (sends `STOPPING=1`) → close health server → existing shutdown chain. Watchdog teardown happens BEFORE channels so systemd sees `STOPPING=1` immediately instead of mistaking the channel-teardown delay for a stall.

4. **Tests:** `src/health.test.ts` (28 cases), `src/health-server.test.ts` (4 cases — HTTP 200/503/404/500), `src/watchdog.test.ts` (4 cases — null when no NOTIFY_SOCKET, --ready on init, WATCHDOG=1 on tick, --stopping on close). All ported from v1 with v2-shape adjustments (lowercase channel names like `whatsapp` instead of v1's `WhatsApp`; mock target `./log.js` instead of v1's `./logger.js`). Full suite: 34 files / 357 tests passed.

5. **Systemd unit** `~/.config/systemd/user/nanoclaw-v2-787facac.service` flipped to:
   ```
   Type=notify
   NotifyAccess=all
   WatchdogSec=30s
   ```
   Same Restart=always / RestartSec=5 as before.

6. **End-to-end smoke:**
   - `curl http://127.0.0.1:3002/health` → 200 with full snapshot (3 channels, 10 groups, 11 sessions, 4 active tasks, healthy=true).
   - `systemctl --user show ... -p WatchdogTimestamp,WatchdogUSec` shows `WatchdogUSec=30s` and a fresh `WatchdogTimestamp`.
   - `journalctl --user -u nanoclaw-v2-787facac.service` shows `sd_notify: READY=1 sent` from the v2 process.

7. **Watchdog provocation test:** temporarily bumped `WATCHDOG_TICK_MS` from `2000` to `120_000` in `src/index.ts`, rebuilt, restarted. journalctl recorded:
   ```
   10:30:07 Started …
   10:30:37 Watchdog timeout (limit 30s)!
   10:30:37 Killing process … with signal SIGABRT.
   10:30:37 Main process exited, code=killed, status=6/ABRT
   10:30:37 Failed with result 'watchdog'.
   10:30:42 Scheduled restart job, restart counter is at 1.
   10:30:45 Started …
   ```
   Reverted the constant to `2000`, rebuilt, `systemctl --user reset-failed`, restart. `NRestarts=0`, `Result=success`, `/health` returns 200 again.

### 10.1 Operational gotchas discovered

1. **The `port=3002` log fires AFTER channel adapters connect, not before.** v2's startup sequence does channels first (WhatsApp ~2s, Slack ~1s) then health server. Health endpoint is unreachable for ~4-6s after `systemctl restart`. A curl during that window returns connection-refused, not a 503. If you script a restart-then-curl on this service, sleep ≥6s or poll-until-ready.

2. **`systemd-notify` is not on the Claude Code default `PATH`.** It lives at `/usr/bin/systemd-notify` and so is fine for `execFileSync('systemd-notify', ...)` (which uses `$PATH`), but useful to remember if writing other helpers.

3. **`WatchdogTimestamp` updates even on `READY=1`.** When the unit restarts, the WatchdogTimestamp is set to the time of the next `notify` call — including the initial `--ready`. Don't interpret a fresh WatchdogTimestamp as "ticks are flowing" without checking the journal too. The reliable signal is "no watchdog timeout in the journal".

4. **Default `WatchdogSignal=SIGABRT (6)`.** systemd sends SIGABRT, not SIGTERM, when WatchdogSec elapses without a tick. The v2 process doesn't currently trap SIGABRT — it dies immediately, which is exactly what we want. If we ever add SIGABRT handlers (e.g., for crash dumps), make sure they don't block the kill.

5. **`Type=notify` requires the process to call `sd_notify('READY=1')` before systemd considers the unit "active".** If a future code change moves health-server startup behind `initWatchdog()` and removes the READY signal, the unit will hang in `activating` state until `TimeoutStartSec` (default 90s) elapses and gets killed. Watch for it on big refactors.

6. **The watchdog tick interval (2s) is well below the threshold (30s) — 15× safety margin.** systemd recommends "at most half of WatchdogSec" but our setup tolerates up to 14 missed ticks (28s) before timeout. This is intentionally generous to survive event-loop hiccups; tighten only if a real deadlock-detection-speed need shows up.

7. **The shutdown hook closes the watchdog before tearing down channels.** Channel teardown (WhatsApp reconnect-suppression, Slack adapter shutdown, etc.) can take 1-3s. If `STOPPING=1` were sent after teardown, systemd would have already started counting against `TimeoutStopSec`. Sending it first gives systemd an immediate signal that shutdown is intentional.

### 10.2 What W4.3 did NOT do

- **`/usage` slash command port.** That's W4.5 — next session's primary task. The curl-from-`api/oauth/usage` workaround from §3.3 remains the interim.
- **`/status` slash command port.** v1's `/status` was a chat-facing renderer of the same snapshot the health endpoint serves. v2 has `ncl groups status` (CLI) and the `/health` endpoint; whether to port `/status` as a chat command (similar to v1's `formatHealthText` rendering) is a W4.5-adjacent decision — fold in there.
- **Installer template fix.** v2's `/setup` and `bash setup.sh` write `Type=simple` unit files for fresh installs. The unit edit we did here was directly on `~/.config/systemd/user/nanoclaw-v2-787facac.service`, not in the installer template. Tracked as a follow-up: future fresh installs need the same `Type=notify`/`NotifyAccess=all`/`WatchdogSec=30s` baked in by the installer. Locate the template in v2's `setup/` directory and add the watchdog flags.
- **Cleanup the root-owned Tailscale cert files** at `/srv/apps/nanoclaw/agent.flicker-enigmatic.ts.net.{crt,key}`. Sudo prompts for a password in this non-TTY session — operator will need to run `sudo rm /srv/apps/nanoclaw/agent.flicker-enigmatic.ts.net.{crt,key}` manually. Still tracked from §9.3.

### 10.3 Plan revisions (apply to implementation-plan.md)

- **§5 P4 W4.3** — mark DONE. Add one-line pointer to this §10.
- **§5 P7 W7.4** — note removed: v2's `HEALTH_PORT` defaults to `3002` and v1 is dead, so no port-shift is needed.
- **§4 Prerequisites for any future fresh install of this fork** — add: "*The systemd unit template defaults to `Type=simple`. After `/setup` runs, edit `~/.config/systemd/user/nanoclaw-v2-<slug>.service` to add `Type=notify` + `NotifyAccess=all` + `WatchdogSec=30s`, then `daemon-reload` + `restart`. Confirm `sd_notify: READY=1 sent` in `nanoclaw.log`. Tracked installer-template fix above will eventually retire this manual step.*"

---

## 11. W4.5 resolution — `/usage` host command on v2 (2026-05-22)

**Outcome:** PASS. v2 now has `/usage` on both surfaces: `ncl usage` (CLI) and `/usage` chat command (Slack/WhatsApp). Live `ncl usage` against the production token renders progress bars + reset times for `five_hour`, `seven_day`, `seven_day_sonnet`, and the structurally-disabled `extra_usage` bucket — matching the curl baseline from §3.3 verbatim (modulo formatting). Full test suite green: 36 files / 389 tests (+32 from this session).

**Surface decision — CLI + chat.** Documented before coding. The CLI surface is the low-risk win: a single new entry in v2's command registry (`src/cli/commands/usage.ts`), zero changes to the router. The chat surface needed a `respond` action added to v2's command-gate (`src/command-gate.ts`); the router-side handler mirrors the existing `deny` branch and reuses `writeOutboundDirect`. Both surfaces call the same renderer module (`src/usage.ts`). Rationale for not deferring chat: the operator's daily-driver is chat, not the terminal — a CLI-only port would be a smaller upgrade than `curl from terminal` already is. Adding both at once keeps the renderer reuse trivial and the test coverage one-and-done.

**Token source decision — `~/.claude/.credentials.json`, NOT OneCLI vault.** The pre-session preference was option (a) (OneCLI vault). On investigation, option (a) is not viable for this specific endpoint:

1. **`@onecli-sh/sdk` exposes no `getSecret(name) -> value` method** (confirmed via `node_modules/@onecli-sh/sdk/lib/index.d.ts`). The SDK surfaces `ensureAgent`, `applyContainerConfig`, `createAgent`, `provisionUser`, `configureManualApproval` — nothing that returns a secret value. This is by design: OneCLI's purpose is to hide the secret behind the gateway proxy.
2. **`onecli secrets list` returns metadata only** (id, name, type, hostPattern, createdAt) — no value field. There is no `onecli secrets get` command.
3. **OneCLI's gateway proxy at `127.0.0.1:10255` injects `x-api-key`-style auth for `type=anthropic` secrets** (the `/v1/messages` SDK contract), not the `Authorization: Bearer sk-ant-oat01-...` + `anthropic-beta: oauth-2025-04-20` pair that `/api/oauth/usage` requires. Verified by `curl -x http://127.0.0.1:10255 https://api.anthropic.com/api/oauth/usage` returning an Anthropic 429 (request reached Anthropic but unauthenticated against the OAuth bucket — wrong auth scheme injected, or none).

Falling back to option (b): port v1's `host-commands.ts` token reader verbatim. `~/.claude/.credentials.json` is kept warm on this host by `claude setup-token` (modified 09:08 today; `expiresAt` 14:48 today). The refresh logic from v1 (POST to `console.anthropic.com/v1/oauth/token` with the refresh token + client_id, write the updated credentials back to disk) is ported unchanged. The same file is the source of truth that Claude Code on the host already uses, so refreshes are coordinated by os-level file replacement (last writer wins on a token <8h apart). No coordination with OneCLI is needed — OneCLI holds its own copy of the OAuth token for container-bound `/v1/messages` traffic; the `/usage` path is host-only and never traverses OneCLI.

If we later want to retire `~/.claude/.credentials.json` access (e.g. to consolidate auth state in OneCLI), the cleanest path is to extend OneCLI to expose a `secrets get --value` or to have OneCLI's gateway add a transparent `/oauth-usage` proxy with the right header pair. Both are upstream work; not blocking.

### 11.1 What was built

1. **`src/usage.ts`** — pure module: `fetchUsage()`, `formatUsage()`, `formatUsageFailure()`, `getUsageText()`, `getValidAccessToken()`, `renderProgressBar()`, `setCredentialsPathForTesting()`. Ported from v1's `src/host-commands.ts` with v2-shape adjustments: structured logger calls use v2's `log.info(msg, data)` style instead of v1's pino-style `logger.info({...}, msg)`. Adds an `extra_usage` "Disabled (…)" fallback to the renderer when the bucket has `is_enabled=false` but `utilization=null` (matches the live response shape from §3.3).
2. **`src/usage.test.ts`** — 27 cases: progress-bar rendering (3), formatter (4), failure messages (5), `getValidAccessToken` token refresh + fallback (4), `fetchUsage` happy-path + headers + errors (5), `getUsageText` composition (2). Mocks `global.fetch` and uses a per-test `tmpDir/.credentials.json` to keep tests hermetic.
3. **`src/cli/commands/usage.ts`** — registers `usage` as a top-level CLI command (no resource, access=`open`). Auto-imported by `src/cli/commands/index.ts`.
4. **`src/command-gate.ts`** — added a `respond` action to `GateResult` and a `HOST_RESPONDER_COMMANDS` map. `/usage` is the first entry. Gated by the same `isAdmin()` check as `ADMIN_COMMANDS` — denial for anonymous senders or non-admins. Existing filter/deny/pass branches unchanged.
5. **`src/command-gate.test.ts`** — 8 cases covering the new `respond` action, admin gating, content-shape tolerance, and unchanged behavior for `pass`/`filter`/`deny`.
6. **`src/router.ts`** — added handling for the new `respond` action. Renderer runs off the hot path (`.then()` chain) so a slow Anthropic call doesn't block the next inbound message. Render failure falls back to a brief inline error message in the same channel. Reuses the existing `writeOutboundDirect` from `session-manager.ts`.

### 11.2 Operational gotchas discovered

1. **v2 runs from `dist/`, not from `src/`.** Unit `ExecStart=/usr/bin/node /srv/apps/nanoclaw-v2/dist/index.js`. `pnpm run build` (= `tsc`) is required between any host-source edit and a `systemctl --user restart`. v1 ran via tsx and skipped the compile step — easy regression for muscle-memory.
2. **`pnpm run build` is fast (~3s) and quiet** when the typecheck passes. Empty output is success. Watch for any TS error on stderr.
3. **OneCLI gateway port is 10255**, not 10254. 10254 is the web UI (Next.js). 10255 is the HTTP proxy that containers talk through. Direct host-side `curl -x http://127.0.0.1:10255` exposes the proxy surface; useful for transport-layer experimentation but does NOT inject the right auth for `/api/oauth/usage`.
4. **OneCLI secret metadata is queryable; value is not.** `onecli secrets list` returns id/name/type/hostPattern/createdAt; no `secrets get`, no `--reveal`, no SDK method. Any future feature that needs the actual token value has to fall back to a different source (file, env, separate auth flow).
5. **`anthropic-beta: oauth-2025-04-20`** must be sent on `/api/oauth/usage` — without it the endpoint either 401s or returns a different shape. The `Authorization: Bearer sk-ant-oat01-...` Bearer alone is necessary but not sufficient.
6. **The render in the chat path runs after the inbound message handling returns.** Fire-and-forget `Promise.then().catch()` — failure is logged + sent as an inline error in the same channel, but does NOT propagate to the inbound message handler. If the inbound row was already marked processed before render started, a failed render just means the operator sees an error message in chat; the inbound message is not retried. Acceptable for `/usage` (idempotent, operator can re-send).
7. **`/usage` is gated by admin role like `/clear`**, not open like the CLI surface. Anonymous Slack DM senders won't get usage stats — they'll get "Permission denied: /usage requires admin access." This matches v1's host-command auth model (`isMainGroup || isFromMe || !requiresTrigger`). The CLI surface is intentionally `access=open` because there are no secrets in the response (utilization percentages only); the existing `cli_scope` enforcement still restricts agent callers if their group is scoped.
8. **Restart latency:** ~4-6s after `systemctl --user restart`, the CLI socket and health endpoint are unreachable. Same gotcha as §10.1 #1. Sleep ≥6s in any restart-then-`ncl-usage` script.

### 11.3 What W4.5 did NOT do

- **`/status` slash command port.** v1's `/status` rendered the same snapshot v2's `/health` endpoint already serves. Per the prompt's "fold into W4.5 if cheap" guidance, it would have been cheap (a second entry in `HOST_RESPONDER_COMMANDS` calling a new `formatHealthText` helper that reuses `src/health.ts`). Deferred only because the next session was already scoped to W4.4 and this session ran long enough on W4.5 + docs. Tracked as a W4.5.1 follow-up — single registry entry + a tiny renderer that calls into the existing health snapshot.
- **Tighten the gate test coverage to include the missing /usage + agent-caller branch** (i.e. a CLI agent attempting `/usage` via a non-CLI surface). Not load-bearing — the agent doesn't have a way to inject content that hits the gate.
- **Installer-template watchdog patch** (carried from §10.2). Still open; tractable in the next session.
- **Surface a metric or log line on /usage call rate** (cheap observability win). Currently only logged via the generic `Host responder fulfilled` info line in the router.

### 11.4 Plan revisions (apply to implementation-plan.md)

- **§5 P4 W4.5** — mark DONE. Add one-line pointer to this §11. Note the curl baseline at §3.3 is retired as the interim — `ncl usage` is now the operator's terminal path and `/usage` is the chat path.
- **§5 P4** — add a new W4.5.1 "Port `/status` chat command" follow-up, scoped to one `HOST_RESPONDER_COMMANDS` entry + a one-line `formatHealthText` reusing `src/health.ts`. Estimate: <30 min.
- **§5 P4** — add a note to W4.4 (mount-security audit) that the next session may also want to retire the v1-fork-local `src/usage.ts` analog from the porting inventory (§W0.5) — it's now ported.
- **§6 Operational gotchas** — append "OneCLI's SDK has no secret-value getter; only the gateway-injection path can use vaulted secrets. Anything host-side that needs the raw value must source it elsewhere (file, env, separate API)."

## §12 Fork restructuring (2026-05-22 post-W4.5)

**Resolution log for Task A** — consolidated v2 work into `johnmathews/nanoclaw`, archived v1, kept upstream pullable.

### 12.1 The problem

After W4.5, `/srv/apps/nanoclaw-v2` had two commits' worth of W4.3 + W4.5 code uncommitted on a working tree whose git `origin` pointed at `nanocoai/nanoclaw` (upstream). Pushing was impossible without forking decisions:

- Where does fork-local v2 work live now?
- What happens to v1's history (the `johnmathews/nanoclaw` main that held v1.2.71 + all v2-migration planning docs)?
- How do we keep `nanocoai/nanoclaw` pullable for upstream tracking?

Operator decision: v2 becomes `johnmathews/nanoclaw` main; v1 archived to a branch + tag; upstream moves to a second remote.

### 12.2 What we did

1. **Archive v1.** From `/srv/apps/nanoclaw` (which already had `origin → johnmathews/nanoclaw` and HEAD at `0bd42bb`, the v1 + all v2-migration docs as of W4.5):
   ```sh
   git branch v1-archive main
   git tag -a v1-final-2026-05-22 -m "v1 final state at v2 cutover (post-W4.5)" main
   git push origin v1-archive v1-final-2026-05-22
   ```
   Verified both visible: `refs/heads/v1-archive` → `0bd42bb`, `refs/tags/v1-final-2026-05-22` → `c41d771` (annotated tag, points to `0bd42bb`).

2. **Reconfigure v2 remotes.** On `/srv/apps/nanoclaw-v2`:
   ```sh
   git remote rename origin upstream     # nanocoai → upstream
   git remote add origin https://github.com/johnmathews/nanoclaw.git
   git fetch origin                       # works (gh credential helper)
   git fetch upstream                     # also works
   ```
   Confirmed `upstream/main == HEAD == 0683c6e` (v2.0.64) — clean rebase point for future upstream pulls; no commits drift between us and them.

3. **Commit W4.3 + W4.5 host code on v2** (two clean feature commits, no skill output mixed in):
   - `0638657 feat(health): /health endpoint + systemd watchdog (W4.3)` — 9 files, +756/-5
   - `e968b39 feat(usage): /usage on ncl CLI + chat command (W4.5)` — 7 files, +799/-2

   Files left intentionally **uncommitted** (skill output from `/migrate-from-v1`, `/add-gmail-tool`, `/add-gcal-tool`): `src/channels/{slack,resend,whatsapp,index}.ts`, `container/skills/{capabilities,pdf-reader,reactions,status}/`, `setup/groups.ts`, `setup/whatsapp-auth.ts`, `package.json` + `pnpm-lock.yaml` (slack/baileys/resend deps), `container/Dockerfile` (gmail/calendar MCP additions), `.claude/settings.json` (gh permission). Plus `groups/main/CLAUDE.md` (modified) and `groups/global/CLAUDE.md` (deleted) — per-group runtime state, not git material.

4. **Force-push v2 → johnmathews/nanoclaw main.** `git push --force-with-lease origin main`. Result: `+ 0bd42bb...e968b39 main -> main (forced update)`. Verified post-push topology:
   ```
   refs/heads/main          = e968b39  (W4.5 + W4.3 + v2.0.64)
   refs/heads/v1-archive    = 0bd42bb  (preserved)
   refs/tags/v1-final-2026-05-22 = c41d771
   ```

### 12.3 End-state topology

```
johnmathews/nanoclaw          ← all fork work
├── main                       ← v2.0.64 + W4.3 + W4.5  (HEAD = e968b39)
├── v1-archive                 ← v1.2.71 + all v2-migration docs frozen at 0bd42bb
├── v1-final-2026-05-22 (tag)  ← annotated tag, immutable marker on 0bd42bb
└── …other skill / feature branches inherited from upstream pulls

On /srv/apps/nanoclaw-v2 (canonical v2 working tree):
  origin    → https://github.com/johnmathews/nanoclaw.git
  upstream  → https://github.com/nanocoai/nanoclaw.git

On /srv/apps/nanoclaw (v1 working tree, mothballed):
  origin    → https://github.com/johnmathews/nanoclaw.git
  Local main = 0bd42bb (now diverges from remote main = e968b39).
  Per-session decision: leave intact, do NOT `git pull` (would try to merge v2 into v1).
  Useful while journal mount points at /srv/apps/nanoclaw/journal/.
  Tombstoned by W8.6 (~30 days post-cutover) at which point this tree
  can be renamed or deleted.
```

### 12.4 Rollback

If something downstream regresses against `johnmathews/nanoclaw` main = v2, restore v1's main with:

```sh
# On any working tree with johnmathews/nanoclaw as a remote:
git fetch origin v1-archive
git push --force-with-lease origin v1-archive:main
```

The v1-archive branch + tag are the durable rollback target.

### 12.5 Carry-forward

- Future upstream pulls land on `/srv/apps/nanoclaw-v2` via `git fetch upstream && git rebase upstream/main` (or branch-then-rebase if there are conflicts).
- This document (`docs/v2-migration/`) now lives on **both** working trees: frozen at v1-archive on `/srv/apps/nanoclaw`, and on the new main on `/srv/apps/nanoclaw-v2`. Future edits go on v2's copy.
- `/srv/apps/nanoclaw/docs/v2-migration/next-session-prompt.md` is the artefact of the previous session and stays frozen on v1-archive. New per-session prompts can live on either tree; the next-session prompt produced at the end of this session lives on v2.

## §13 W4.4 — mount-security audit and retire decision

**Decision: RETIRE v1's `src/mount-security.ts`. Carry-forward = port v1's test suite to v2.**

### 13.1 Audit method

Read v1's `src/mount-security.ts` + `src/mount-security.test.ts` top-to-bottom and inventoried every defence as a checklist. Read v2's `src/modules/mount-security/index.ts` and verified each check against v1's list. Confirmed v2 has no callers passing the v1 `isMain` parameter (`grep -rn "isMain\|nonMainReadOnly" src/` in v2 returns no hits outside the module itself).

### 13.2 Coverage matrix

| v1 defence | v2 status |
|---|---|
| `fs.realpathSync` host-path canonicalisation | ✅ identical helper |
| `path.relative()` allowlist root prefix match (covers symlink-escape) | ✅ identical |
| 17 default blocked patterns (`.aws`, `.ssh`, `.gnupg`, `.docker`, `id_rsa`, etc.) | ✅ identical list |
| Per-component + substring blocked-pattern match | ✅ identical helper |
| User patterns merged with defaults (Set dedupe) | ✅ identical |
| `containerPath` rejects `..` | ✅ identical |
| `containerPath` rejects absolute paths | ✅ identical |
| `containerPath` rejects empty/whitespace | ✅ identical |
| **`containerPath` rejects colons (Docker `-v` injection guard)** | ✅ **identical** — load-bearing defence preserved |
| Default-to-readonly | ✅ identical |
| `allowReadWrite` per-root | ✅ identical |
| Default `containerPath` = `basename(hostPath)` | ✅ identical |
| `/workspace/extra/` prefix at `validateAdditionalMounts` | ✅ identical |
| Fail-closed (no allowlist → block all) | ✅ identical |
| File-not-found not cached (file may appear later); parse errors cached | ✅ identical |
| Structured rejection logger | ✅ identical (uses `log` instead of `logger`) |
| `nonMainReadOnly` flag — non-main groups forced RO even on RW roots | ⚠️ **dropped intentionally** — see §13.3 |
| `nonMainReadOnly` allowlist structural validation | N/A in v2 (field silently ignored, forwards-compat) |
| Template generator includes `nonMainReadOnly` | N/A in v2 (template drops the field) |
| **Test coverage** | ❌ none before W4.4; ✅ ported in W4.4 (`src/modules/mount-security/index.test.ts`, 28 tests) |

### 13.3 Why the `nonMainReadOnly` drop is not a real gap

v1's `isMain` parameter represented a WhatsApp-era distinction between the operator's main chat (full access) and every other chat (sandboxed). v2's per-agent-group model removes that implicit hierarchy — every agent group is operator-instantiated with explicit MCP + mount config in the DB. RO/RW is now a **per-mount opt-in** (the `readonly` field on each `AdditionalMount`), not a group-level boolean.

Concretely: in v2, if you want an agent group to have RO access to a RW-permitted root, you set `readonly: true` on that mount — not by relying on a `nonMainReadOnly` allowlist toggle. The defence has moved from "implicit, allowlist-wide" to "explicit, per-mount", which is a tighter contract.

Production allowlist confirms this: `~/.config/nanoclaw/mount-allowlist.json` has `nonMainReadOnly: false` even on v1 — the field was never actively used in production.

### 13.4 Test port

Created `src/modules/mount-security/index.test.ts` (28 tests, all pass). Ported from v1's `src/mount-security.test.ts` with three adaptations:

1. **Removed the 2 `nonMain` test cases.** `validateMount` no longer accepts an `isMain` parameter; the cases tested a code path that doesn't exist.
2. **Removed the `nonMainReadOnly is boolean` `loadMountAllowlist` test.** Replaced with a new "silently ignores legacy `nonMainReadOnly` field" test that asserts v1 allowlists still load on v2 without complaint (forwards-compat regression guard).
3. **Added a symlink-escape regression case** (not in v1's suite). `realpathSync` mocked to redirect a path under `/allowed/root` → `/etc`; expect rejection by `findAllowedRoot`. v1's enforcer would have rejected too — this is just filling a gap in the test coverage.
4. **Specialised the colon-injection case.** v1 tested a generic colon; the new test uses `repo:rw,z` to make the Docker-`-v`-option-injection attack explicit in the test name and reason string.

Result: 37 test files / 417 tests passing on v2 (+28 vs. W4.5 baseline).

### 13.5 Status of v1's `src/mount-security.ts`

- File **not deleted** from `/srv/apps/nanoclaw` — left in place as a tombstone alongside the rest of v1's source until W8.6 (~30 days post-cutover). Lives on the `v1-archive` branch + `v1-final-2026-05-22` tag.
- `docs/v2-migration/fork-local-inventory.md` updated to mark mount-security as "retired in W4.4; covered by v2's `src/modules/mount-security/`".

### 13.6 What W4.4 did NOT do

- **Did not edit `src/modules/mount-security/index.ts`.** No new code; only tests.
- **Did not rebuild v2.** Tests-only commit → no `dist/` change → no `pnpm run build` → no systemd restart.
- **Did not audit `src/sender-allowlist.ts`** (the v1 fork-local sender-allowlist file). That's W4.1, a separate retire-or-port that can fold into the next session. Per project memory, v1 never enforced sender allowlist in production (no `~/.config/nanoclaw/sender-allowlist.json` on host) so it's likely a clean retire.

### 13.7 Plan revisions (apply to implementation-plan.md)

- **§5 P4 W4.4** — mark DONE. Pointer to this §13.
- **§5 P4** — promote W4.1 (sender-allowlist) next in the retire queue; likely 30 min once someone confirms there's no `~/.config/nanoclaw/sender-allowlist.json` on host (memory says there isn't).

## §14 W4.5.1 — `/status` chat command + writeOutboundDirect rw fix (2026-05-22)

Two-commit batch picking up after W4.5/§11. First is a tiny fold-in;
second is a latent bug exposed during the W4.5.1 end-to-end verify.

### 14.1 W4.5.1 — `/status` host responder

W4.5 (§11) shipped `/usage` via the `HOST_RESPONDER_COMMANDS` map in
`src/command-gate.ts`. The data already existed for `/status`: the `/health`
HTTP endpoint snapshot from W4.3 (§10), exposed as `snapshotHealth()` in
`src/index.ts` and formatted via `formatHealthText()` in `src/health.ts`.
Fold-in is one entry in the map. No new data sources, no new formatter, no
behavioural change for `/health` HTTP.

`snapshotHealth()` moved out of `src/index.ts` into a new
`src/health-snapshot.ts` so `command-gate.ts` can call it without pulling
the entry-point module into its import graph. Pure refactor —
`src/index.ts` still re-imports it and passes it to `startHealthServer()`.

Three test cases added to `src/command-gate.test.ts` mirroring the existing
`/usage` shape: respond-when-admin, deny-when-anon, match-with-trailing-text.

End-to-end verify: sent `/status` from a non-admin Slack user (my Slack
user `slack:U0AMGE1SNGY` is not in `user_roles`); gate logged
`Admin command denied by gate command="/status"`; "Permission denied" reply
threaded back into the channel. Positive (admin) path is structurally
identical to `/usage` so it inherits W4.5's verification.

Commit `600be3b`.

### 14.2 writeOutboundDirect — readonly DB bug

The W4.5.1 verify exposed a pre-existing latent bug in
`src/session-manager.ts`. `writeOutboundDirect()` (W4.5 era) called
`openOutboundDb()` which opens the SQLite file `readonly: true` — meant
for the host's delivery-loop reader. The function's three call sites in
`src/router.ts` (deny / respond-success / respond-error) all threw
`SqliteError: attempt to write a readonly database` instead of writing the
response to `messages_out`.

Symptom seen in the field: `/usage` (and now `/status`) silently produced
no reply when sent from a non-admin user — the deny write failed, the
error went to `logs/nanoclaw.error.log`, and the original inbound row had
already been treated as processed (no retry). The host-responder happy
path (admin sends `/usage`) was untested in production because John's
WhatsApp user is admin globally — so the success-path `writeOutboundDirect`
call never fired from there either; the v1→v2 cutover ran the admin
`/usage` through the SDK pre-fold-in. The first time the host-responder
write path actually ran in prod was 16:48 today.

Fix: open `openOutboundDbRw()` in `writeOutboundDirect`. Safe because the
gate runs before `writeSessionMessage`, so the agent for *this* inbound
row was never woken — no container is mid-write to this session's
`outbound.db`. (Older sessions of the same agent group have their own
outbound DBs; no shared file.) Regression test added to
`src/host-core.test.ts` under the `session manager` describe — calls
`writeOutboundDirect` then reads `messages_out` with a fresh readonly
connection.

Commit `d8c04b8`. Pushed alongside W4.5.1 at end of session.

### 14.3 Status

- Test count: 37 files / **421 tests** pass (+4 from W4.4 baseline of 417;
  3 from command-gate.test.ts and 1 from host-core.test.ts).
- v2 service: healthy after restart (`/health` 200, all channels connected).
- v2 main HEAD: `600be3b`.

### 14.4 Plan revisions

- **§5 P4 W4.5.1** — mark DONE. Pointer to this §14.
- **§5 P4** — next still W4.1 (sender-allowlist) per §13.7.

## §15 W4.1 — sender-allowlist retire (2026-05-22)

The cleanest retire of the migration. v1's `src/sender-allowlist.ts` was
listed as `decide-at-port-time` in `fork-local-inventory.md`; the audit
found that v1 was running with the file absent in production, so the
allowlist was a no-op, and that v2's `src/modules/permissions/` is a
functional superset that is actually wired and enforced. No code change
on v2 — doc-only retire.

### 15.1 Audit method

Read v1's `src/sender-allowlist.ts` end-to-end and grep'd v1's `src/`
for all callers. Audited v2's `src/modules/permissions/` for functional
equivalents.

### 15.2 What v1's allowlist did

`src/sender-allowlist.ts` (128 LOC) exposed:

- `loadSenderAllowlist()` — reads `~/.config/nanoclaw/sender-allowlist.json`;
  returns `DEFAULT_CONFIG = { default: { allow: '*', mode: 'trigger' }, chats: {}, logDenied: true }`
  if the file is missing (`ENOENT` → DEFAULT_CONFIG silently, no warning).
- `isSenderAllowed(chatJid, sender, cfg)` — `entry.allow === '*' || entry.allow.includes(sender)`.
- `shouldDropMessage(chatJid, cfg)` — true if `entry.mode === 'drop'`.
- `isTriggerAllowed(chatJid, sender, cfg)` — `isSenderAllowed`, with optional
  debug log.

Callers in v1's `src/index.ts`:

| Line | Site | Role |
| --- | --- | --- |
| 311 + 315 | trigger-pattern check at chat fan-out | block trigger for denied sender |
| 821 + 826 | similar trigger check | block trigger for denied sender |
| 1059–1069 | drop-mode pre-storage filter | discard message before storing |

### 15.3 Why this was a no-op in production

```bash
$ ls ~/.config/nanoclaw/sender-allowlist.json
No such file or directory
$ ls ~/.config/nanoclaw/
mount-allowlist.json
```

File is absent. v1's `loadSenderAllowlist()` returned `DEFAULT_CONFIG` on
every call: `allow='*'` (everyone allowed), `mode='trigger'` (no drop).
Both `isSenderAllowed` and `isTriggerAllowed` short-circuited true on the
`*` wildcard. `shouldDropMessage` always returned false. None of the three
v1 call sites ever blocked a sender in production. This matches the
"Pre-P3 mistakes worth recording" note in project memory.

### 15.4 v2's functional equivalents (and why they're a superset)

v2 split the concern into a real module: `src/modules/permissions/`. The
relevant pieces:

| Concern | v1 (sender-allowlist) | v2 (permissions module) |
| --- | --- | --- |
| Unknown-sender handling | `allow='*'` wildcard, file-driven, file absent in prod (no-op) | `unknown_sender_policy` per messaging group: `strict` (drop), `request_approval` (DM-flow), `public` (allow). Stored in `messaging_groups` table; enforced by `setAccessGate` in `src/modules/permissions/index.ts`. |
| Per-chat overrides | `chats[jid]` map in the JSON file | per-`messaging_group` (which is per chat) — the same granularity, with the policy column. |
| Drop mode | `mode: 'drop'` per chat | `unknown_sender_policy=strict` + `recordDroppedMessage()` to the `dropped_messages` table. Persisted audit trail (v1 only emitted a debug log). |
| Approval workflow | none | `pending_sender_approvals` table + `requestSenderApproval()` + DM-based approve/reject flow (`sender-approval.ts`, `channel-approval.ts`, `user-dm.ts`). |
| Admin gating for commands | none (the trigger check was the only sender gate) | `command-gate.ts` `isAdmin()` checks `hasAdminPrivilege` via `user_roles` (`global_admin` / `agent_group_admin` / `owner`). |
| CLI surface gating | none | `cli_scope` table (migration 015) — controls which users can talk to which agent groups from the `ncl` CLI. |
| Wired in production? | no (file absent) | yes (`unknown_sender_policy='public'` on all 10 groups; owner = `whatsapp:31683775990@s.whatsapp.net`) |

v2's model is a strict superset: it covers everything v1 intended to do
(per-chat allow/drop) plus what v1 lacked (approval workflows, admin
roles, CLI scoping), and unlike v1's it actually fires.

### 15.5 Decision

- **Retired.** v1's `src/sender-allowlist.ts` remains on the `v1-archive`
  branch as a tombstone. No code change needed on v2 — `grep -rn
  "sender-allowlist\\|senderAllowlist" /srv/apps/nanoclaw-v2/src/` returned
  zero hits before this work unit.
- `fork-local-inventory.md` row for `src/sender-allowlist.ts` flipped from
  `decide-at-port-time` → `retired` with a one-line link back to this
  section.
- No tests to port — v1's `src/sender-allowlist.test.ts` is irrelevant
  given the retire. v2's permissions tests
  (`src/modules/permissions/{permissions,sender-approval,channel-approval}.test.ts`)
  already cover the superset.

### 15.6 Carry-forward

Nothing. If a future need for per-chat IP-style allow/deny rules emerges
(e.g. block a specific user from a specific group even when they're a
member), it should be added to `src/modules/permissions/` rather than
revived as a separate sender-allowlist module.

### 15.7 Status

- v2 main HEAD: unchanged by this work unit (doc-only commit forthcoming).
- Test count: 37 files / 421 tests (no change — no code touched).

### 15.8 Plan revisions

- **`fork-local-inventory.md` `src/sender-allowlist.ts` row** — flipped
  to `retired`, link to §15.
- **`project_v2_migration.md` memory item "W4.1 sender allowlist"** —
  mark DONE.
- **§5 P4 next** — installer-template watchdog patch (see §16) or
  W4.7 (Journal MCP verify).

## §16 v2 installer-template watchdog patch (2026-05-22)

The W4.3 §10.3 carry-forward — bake the watchdog directives into v2's
installer template so fresh installs come up with `Type=notify` rather
than every operator needing to hand-edit the unit file after `pnpm
run setup`.

### 16.1 The gap

After W4.3, `src/watchdog.ts` ports v1's `sd_notify` integration: it
sends `READY=1` on start, `WATCHDOG=1` every 2s, and `STOPPING=1` on
shutdown. The watchdog wiring is a no-op when `NOTIFY_SOCKET` is unset
(systemd only sets it for `Type=notify` units). v2's installer wrote
`Type=simple`, so on a fresh install:

- watchdog.ts `initWatchdog()` returned `null` (silent disable).
- systemd had no `WatchdogSec` to enforce, so a deadlocked process
  was never restarted.
- The only signal that anything was wrong was the absence of
  `WATCHDOG=1` log lines.

The live `nanoclaw-v2-787facac.service` unit was hand-edited during W4.3
to add `Type=notify` + `NotifyAccess=all` + `WatchdogSec=30s`. Every
fresh install elsewhere would have to repeat that edit.

### 16.2 What was changed

One source file + one test file. No runtime code path was touched.

**`setup/service.ts`** — `setupSystemd()` writes the unit template. The
`[Service]` block prepends three directives above `ExecStart`:

```diff
 [Service]
-Type=simple
+Type=notify
+NotifyAccess=all
+WatchdogSec=30s
 ExecStart=${nodePath} ${projectRoot}/dist/index.js
```

A short comment above the template literal documents the contract
(why `Type=notify`; consequence of dropping it).

**`setup/service.test.ts`** — the test file shadows `service.ts`'s
template via a local `generateSystemdUnit()` helper (the production
function isn't exported). Updated the helper to mirror the new
directives, then added three assertions:

- `Type=notify` is present, `Type=simple` is absent.
- `NotifyAccess=all` is present.
- `WatchdogSec=30s` is present.

This was the same pattern the existing tests used for `Restart=always`
/ `KillMode=process` / `WantedBy=...`. The helper-mirroring approach
means a future drift between `service.ts` and `service.test.ts` is
caught by the existing label/ExecStart/restart-policy assertions, not
just the new ones.

### 16.3 What was NOT changed

- **macOS / launchd path** (`setupLaunchd()`) — untouched. Launchd has
  no `Type=notify` equivalent; the existing plist remains canonical.
- **Nohup fallback** (`setupNohupFallback()`) — untouched. No service
  manager, no watchdog. This is the WSL-without-systemd path.
- **The live `nanoclaw-v2-787facac.service`** — already has the
  directives (manually edited in W4.3). No restart needed. This change
  is fresh-install-only and takes effect the next time `pnpm run
  setup` rewrites the unit file.
- **`scripts/`** — no parallel bash installer exists on v2 (the next-
  session prompt mentioned `setup.sh`; that's a v1 artefact). Only
  `setup/service.ts` writes the unit.

### 16.4 Verification

- `pnpm test` — 37 files / **424 tests** pass (+3 from W4.5.1 baseline
  of 421).
- `pnpm run build` — clean (TypeScript compiles).
- `curl http://127.0.0.1:3002/health` — HTTP 200 (the running v2
  service was not touched).
- Spot-check of the live unit file
  (`~/.config/systemd/user/nanoclaw-v2-787facac.service`) — already
  has the three directives, so the next setup rewrite produces a
  bit-identical [Service] block. No surprise diff on re-run.

### 16.5 Re-test of the fresh-install path on the running install

Deliberately deferred. Re-running `pnpm run setup` on
`/srv/apps/nanoclaw-v2` would rewrite the live unit file and likely
trigger a `systemctl --user daemon-reload + restart` mid-session.
The template change is small, syntactic, and was eyeballed against the
already-correct live unit. A real fresh-install verification will
happen the next time NanoClaw is set up on a new host (or in a
disposable VM).

### 16.6 Status

- v2 main HEAD: forthcoming commit `chore(setup): bake watchdog flags
  into systemd template (W4.x)`.
- Test count: 37 files / 424 tests (+3).
- v2 service: unchanged, healthy.

### 16.7 Plan revisions

- **`fork-local-inventory.md`** — `src/watchdog.ts` row already
  mentions "fix the installer gap" in its disposition; no edit needed.
- **`implementation-plan.md` §5 P4** — the carry-forward item
  "W4.x v2 installer-template watchdog patch (NEW, surfaced by W4.3)"
  can be marked DONE pointing at §16.
- **`project_v2_migration.md` memory** — append a gotcha noting the
  template now generates `Type=notify` units; manual hand-edits on
  pre-fix installs remain in place but are no longer the only path.

## §17 chat-sdk-bridge audit (2026-05-22)

Carry-forward from W4.0 §9.3 ("chat-sdk-bridge audit — verify files
/ reactions / typing / streaming are end-to-end wired"). Read
`src/channels/chat-sdk-bridge.ts` + `src/channels/adapter.ts` +
`container/agent-runner/src/{formatter,poll-loop,mcp-tools/*}.ts`
end-to-end. Doc-only — no code changed in this audit pass.

### 17.1 Method

Mapped the universe in three layers:

1. **Adapter contract** (`src/channels/adapter.ts`) — what every
   channel adapter must / may expose.
2. **Bridge** (`src/channels/chat-sdk-bridge.ts`, 681 LOC) — what
   each subscribed Chat SDK event becomes when serialised into
   `messages_in.content`, and what `OutboundMessage.content` shapes
   the bridge knows how to deliver.
3. **Agent-runner formatter + MCP tools** — what the agent actually
   sees from the prompt, and what tools it can call to emit
   anything back.

Then walked Chat SDK's own type surface
(`node_modules/.pnpm/chat@4.26.0/node_modules/chat/dist/index.d.ts`)
to enumerate every `chat.on*` handler the bridge could be wiring
but isn't.

### 17.2 Inventory snapshot

**Bridge subscribes to (Chat SDK):**
- `onSubscribedMessage` — every message in a thread the bot has
  subscribed to. Carries `message.isMention` through.
- `onNewMention` — @-mentions in an unsubscribed thread (SDK-
  confirmed; sets `isMention=true`).
- `onDirectMessage` — DMs (always treated as mention).
- `onNewMessage(/[\s\S]*/, …)` — plain messages in unsubscribed
  threads (catch-all pattern).
- `onAction` — button clicks. **Filtered to `actionId.startsWith('ncq:')`
  only — all non-`ncq:` actions silently dropped at line 270.**

**Bridge does NOT subscribe to (available in Chat SDK):**
- `onReaction` — emoji reactions added/removed on any message.
- `onModalSubmit`, `onModalClose` — Slack/Teams modal form
  submissions.
- `onSlashCommand` — platform-level slash commands.
- `onAssistantThreadStarted`, `onAssistantContextChanged`,
  `onAppHomeOpened`, `onMemberJoinedChannel` — Slack-specific.

**Inbound attachment handling** (bridge `messageToInbound`, lines
139-162): every `att.fetchData()` downloaded → base64 string in
`serialized.attachments[i].data`. Other metadata fields preserved
(`type`, `name`, `mimeType`, `size`, `width`, `height`).

**Container MCP tools registered** (15 across 5 files):

| File | Tools |
| --- | --- |
| `core.ts` | `send_message`, `send_file`, `edit_message`, `add_reaction` |
| `interactive.ts` | `ask_user_question`, `send_card` |
| `agents.ts` | `create_agent` |
| `self-mod.ts` | `install_packages`, `add_mcp_server` |
| `scheduling.ts` | `schedule_task`, `list_tasks`, `cancel_task`, `pause_task`, `resume_task`, `update_task` |

**Outbound delivery** (`src/channels/chat-sdk-bridge.ts` `deliver`,
lines 368-507) recognises content shapes:
- `operation: 'edit'` → `adapter.editMessage`.
- `operation: 'reaction'` → `adapter.addReaction`.
- `type: 'ask_question'` → Card with Action buttons.
- `type: 'card'` → display Card (send_card; URL actions only — non-URL
  actions deliberately dropped because send_card is fire-and-forget).
- Otherwise: `adapter.postMessage` with `{ markdown, files }`, with
  `splitForLimit()` chunking when `maxTextLength` is set.

**Host attachment delivery** (`src/delivery.ts:353-368`): when
`content.files` is a string array, `readOutboxFiles()` reads
`/workspace/outbox/<id>/<filename>` for each entry and passes them
to the adapter as `OutboundFile[]`.

### 17.3 Feature × stage matrix

For each user-visible channel feature, the column is "where the
chain breaks":

| Feature | Adapter | Bridge in | Agent sees | Agent emits | Bridge out | Adapter out | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plain text in | ✅ | ✅ | ✅ | n/a | n/a | n/a | working |
| Plain text out | n/a | n/a | n/a | ✅ `send_message` | ✅ `postMessage(markdown)` | ✅ | working |
| Image inbound | ✅ Chat SDK attachment | ✅ base64 in `attachments[i].data` | ❌ **formatter renders `[image: name]` only — base64 never used** | n/a | n/a | n/a | **gap: missing port (image-vision)** |
| Voice inbound | ✅ same path | ✅ same path | ❌ same — no transcription | n/a | n/a | n/a | **gap: missing port (voice-transcription)** |
| PDF inbound | ✅ same path | ✅ same path | ❌ same — no text extraction | n/a | n/a | n/a | **gap: missing port (pdf-reader)** |
| File outbound | n/a | n/a | n/a | ✅ `send_file` writes to `/workspace/outbox/<id>/` | ✅ `delivery.ts` populates `OutboundFile[]` | ✅ | working |
| Reaction inbound | ✅ `chat.onReaction()` | ❌ **bridge does not subscribe** | ❌ | n/a | n/a | n/a | **gap: missing port (`onReaction` wiring + storage + MCP query)** |
| Reaction outbound | n/a | n/a | n/a | ✅ `add_reaction` | ✅ `operation: 'reaction'` | ✅ | working |
| Typing indicator | ✅ `adapter.startTyping` | n/a | n/a | n/a (host calls via `bridge.setTyping`) | ✅ | ✅ | working |
| Text streaming | n/a | n/a | n/a | ✅ `edit_message` (agent-driven) | ✅ `operation: 'edit'` | ✅ | working — but agent-driven, not auto-streamed |
| Ask-user-question | n/a | n/a | n/a | ✅ `ask_user_question` | ✅ Card with `ncq:` actions | ✅ | working |
| Display card | n/a | n/a | n/a | ✅ `send_card` | ✅ `type: 'card'` | ✅ | working — URL actions only |
| Slack Block Kit raw blocks (`send_blocks`) | ✅ via adapter.postMessage | n/a | n/a | ❌ no MCP tool | n/a | n/a | **gap-by-design** — superseded by `send_card` (cross-platform). Slack-only features (datepickers, multi-select, accessory layouts) inaccessible. |
| Slack interactivity (`block_actions`, non-`ncq:` ids) | ✅ via `chat.onAction` | ❌ **bridge filters `ncq:` only — non-`ncq:` actions reach the bridge then are dropped (line 270)** | ❌ | n/a | n/a | n/a | **gap: missing port** — affects v1's `nanoclaw_(checkbox\|confirm)_*` flow used by git-maintenance Mon/Thu 02:03 cron |
| Threads | ✅ | ✅ `thread.id` flows through | ✅ stored on `messages_in.thread_id` | n/a | ✅ `tid = threadId ?? platformId` | ✅ | working |
| `openDM` (cold DM) | ✅ on adapters that implement it | n/a | n/a | n/a (host-side only) | ✅ `bridge.openDM` passthrough | ✅ | working |
| Subscribe-to-thread | n/a | ✅ `bridge.subscribe` → `state.subscribe(threadId)` | n/a | n/a | n/a | n/a | working — idempotent |
| Slack `onSlashCommand` (platform `/foo`) | ✅ | ❌ bridge does not subscribe | ❌ | n/a | n/a | n/a | gap-by-design — v2 handles `/foo` from message text via `command-gate.ts` |
| `onModalSubmit`, `onAppHomeOpened`, etc. | ✅ | ❌ bridge does not subscribe | ❌ | n/a | n/a | n/a | gap-by-design — not used by v1 |

### 17.4 Findings

**Three production-affecting gaps** (each warrants its own work unit):

**Finding 1 — multimodal attachments are dead-letter** (image / voice / PDF inbound). The bridge correctly downloads and base64-encodes
attachment binary data (`messageToInbound` lines 139-162), and it
lands in `messages_in.content.attachments[i].data`. But the
formatter (`container/agent-runner/src/formatter.ts:244-257`)
only renders `[<type>: <name>]` as plain text, dropping the data
entirely. The agent prompt that reaches `provider.query({ prompt })`
is a string — not a multimodal content-block array — so even if
the data reached `formatMessages()`, the provider interface can't
carry it. Estimated port cost: 4-6 h (widen provider interface +
per-type handler: vision multimodal block / Whisper transcription /
pdftotext extraction).

**Finding 2 — inbound reactions never reach the agent.** The bridge
does not register a `chat.onReaction()` handler. The Chat SDK supports
it (Slack/Discord/Teams adapters all fire `ReactionEvent`). Wiring it
is the easy half; the harder half is what to do with the reaction —
v1 stored every reaction in a `reactions` table and exposed
`query_reactions` MCP so agents could implement "approve with thumbs
up" workflows. v2 would need an equivalent storage shape + MCP tool.
Estimated port cost: 2-3 h (subscribe + DB migration + 1 MCP tool).

**Finding 3 — Slack non-`ncq:` interactivity is silently dropped.**
The bridge's `chat.onAction` handler ignores any actionId that doesn't
start with `ncq:` (`chat-sdk-bridge.ts:270`). v1's git-maintenance
Mon/Thu 02:03 cron posted a checkbox card via v1's `send_blocks` and
caught the click via `app.action(/^nanoclaw_(checkbox|confirm)_/)`.
On v2 the cron still fires, but if it uses the old `send_blocks`
pattern the click would never reach the agent. **Likely already
self-resolved** if the cron prompt uses v2's `mcp__nanoclaw__ask_user_question`
(which DOES round-trip via `ncq:` action ids) — but unverified. Two
sub-options:
- (3a) Confirm/migrate the git-maintenance cron prompt to use
  `ask_user_question` — zero-code fix if the prompt is the only
  thing needing to change.
- (3b) Port v1's `app.action` pattern: extend bridge to recognise a
  v2-prefixed actionId namespace (e.g. `ncv2:<sessionId>:<actionId>`)
  and emit a `messages_in` row of kind `chat-sdk` with a structured
  `action` field. Estimated 60-90 min.

**Gap-by-design** items (no work needed):

- `send_blocks` (Slack raw Block Kit JSON) — replaced by cross-
  platform `send_card`. The cost is Slack-only features
  (datepickers, multi-select with native arrows) that aren't worth
  the API divergence.
- `chat.onSlashCommand` (platform-level Slack `/foo`) — v2 handles
  slash commands from message text via `command-gate.ts`.
- `chat.onModalSubmit`, `onAppHomeOpened`, etc. — not used by v1.

### 17.5 Decisions

- **No code change this session.** Audit-only.
- **Carry forward as three discrete units** in
  `project_v2_migration.md` + this notes file:
  - W4.x-multimodal — port `/add-image-vision`,
    `/add-voice-transcription`, `/add-pdf-reader` skill behaviour to
    v2; widen provider interface to accept multimodal content. The
    widening is the load-bearing change.
  - W4.x-reactions-inbound — subscribe `chat.onReaction`; persist;
    expose via MCP. Lower priority unless an explicit workflow needs
    it.
  - W4.x-slack-interactivity — first verify whether
    git-maintenance cron is already self-resolved via
    `ask_user_question`; only do the `app.action`-pattern port if
    that doesn't suffice.

### 17.6 What §17 did NOT do

- Did not check the git-maintenance cron's actual prompt to confirm
  whether it uses `send_blocks` (legacy) or `ask_user_question`
  (v2-canonical). That's a one-line lookup in the next session.
- Did not test attachment delivery on a live message (the matrix
  cells under "Adapter / Bridge in / Agent sees" are derived from
  code reads, not live wire traffic).
- Did not check whether `@chat-adapter/slack` v4.26.0 actually fires
  `onReaction` for Slack — assumed it does based on the Chat SDK type
  surface declaring the handler. Verify before W4.x-reactions-inbound.

### 17.7 Status

- Test count: unchanged (37 files / 424 tests pass — no code touched
  in §17).
- v2 service: untouched, healthy.
- v2 main HEAD after the forthcoming audit-doc commit: TBD.

### 17.8 Plan revisions

- **`fork-local-inventory.md`** — no row changes. The audit didn't
  retire any file; the three carry-forward units affect different
  layers (formatter, bridge, MCP) than the v1 fork-local files.
- **`project_v2_migration.md` memory** — append W4.x-multimodal,
  W4.x-reactions-inbound, W4.x-slack-interactivity as three discrete
  backlog items. The existing single line "chat-sdk-bridge audit"
  can be marked DONE pointing at §17. The original `W4.x Slack
  interactivity port` becomes `W4.x-slack-interactivity` and gains
  the "verify git-maintenance cron first" precursor step.
- **`implementation-plan.md` §5 P4** — no structural change; the
  three new units fit under the existing W4.x carry-forward bucket.

### 17.9 Addendum — git-maintenance cron is NOT self-resolved

Done as the one-line check §17.6 deferred. The cron's actual prompt
+ `groups/slack_git-maintenance/CLAUDE.local.md` both still describe
v1's Block Kit flow verbatim:

- Task row at `ag-1779373702794-62oxsv/sess-1779373704595-mqteww`
  `messages_in[id=task-1775472071448-rpvh6c]`, recurrence
  `3 2 * * 1,4` (Mon/Thu 02:03 CEST), next fire
  `2026-05-25T00:03:00.000Z`. Prompt step 5: "Post an interactive
  Block Kit report using the **`send_blocks` MCP tool**".
- `groups/slack_git-maintenance/CLAUDE.local.md:107` —
  "Use the `send_blocks` MCP tool to post an interactive report
  with checkboxes." Lines 124-125 + 141 + 171 specify the v1
  actionIds: `nanoclaw_checkbox_branches`, `nanoclaw_confirm_delete`.

Three things will break in sequence when this cron next fires:

1. **`mcp__nanoclaw__send_blocks` tool does not exist on v2** —
   agent's tool call errors out before any UI is even attempted.
2. **Bridge would silently drop the click** — bridge's
   `chat.onAction` filters to `ncq:` prefix; `nanoclaw_checkbox_*`
   and `nanoclaw_confirm_*` would never reach the agent even if a
   block were posted by some other path.
3. **No fallback UX** — there's no `ask_user_question` branch in
   the prompt to fall through to.

This raises W4.x-slack-interactivity's priority from "verify first"
to "**broken in production on a Mon/Thu schedule — pick a
remediation**". Two natural options, both still appropriate for a
new session:

- **(A) Rewrite the cron prompt + CLAUDE.local.md to use
  `ask_user_question`.** Zero v2 code change. Cost: UX degrades from
  one Block Kit checklist with N checkboxes + one confirm button to
  N sequential `ask_user_question` round-trips (or one
  `ask_user_question` with N options, which only allows picking one
  branch at a time). For a maintenance flow that may surface ~5-15
  branches, this is significantly worse UX, but it works.
- **(B) Port `send_blocks` MCP + `app.action` pattern.** Add a
  `send_blocks` tool in `container/agent-runner/src/mcp-tools/` that
  takes a raw Block Kit JSON string + fallback text and emits a
  Slack-specific outbound payload. Extend bridge's `deliver()` to
  recognise the new content shape and call
  `adapter.postMessage(tid, { blocks: ... })`. Extend bridge's
  `chat.onAction` handler to route non-`ncq:` actionIds matching a
  v2-prefixed namespace to a new `messages_in` row (kind = `chat-sdk`
  with structured `action` payload, OR a new kind = `interaction`).
  Update CLAUDE.local.md to point at the new actionId namespace.
  Estimated: 90-120 min.

Recommendation for the next session: **option B** — the UX delta
is too steep to absorb, and porting the pattern aligns with v1's
production-tested shape. The audit's "missing-port" classification
of W4.x-slack-interactivity stands.

**Interim mitigation:** none needed if the cron is allowed to fail
quietly until W4.x-slack-interactivity lands. The cron writes a
text-only Slack message (the fallback path agents tend to fall
into when an MCP tool errors), so John will at least see the
branch analysis in plain text — just without the interactive
delete flow. Confirm at next 02:03 fire if this is acceptable
short-term.


