# NanoClaw v1 → v2 Migration: Motivation and Context

**Status:** active. **Last updated:** 2026-05-21 (post-P1 revision). **Supersedes:** pre-P1 §5/§6/§7/§8 (load-bearing mechanism replaced — see [spike-notes.md](spike-notes.md) §3 for the inversion).

**See also:** [implementation-plan.md](implementation-plan.md) for the step-by-step plan derived from the decisions captured here, and [spike-notes.md](spike-notes.md) for the immutable record of the P1 spike that inverted the credential-proxy decision.

## 1. Executive summary

This fork is on v1.2.71, forked from upstream at v1.2.19; upstream is now v2.0.64. v2.0.0 (released 2026-04-22) was a substantial architectural rewrite — entity model, DB layout, container runtime, channel distribution, host process shape, and package manager all changed. We are migrating because the gap is widening (471 fork commits vs 1307 upstream commits since divergence) and v2 is upstream's bet on what NanoClaw is going forward. The plan is Strategy A: a side-by-side install of fresh upstream v2 in a sibling directory, port v1 data via upstream's `migrate-v2.sh`, re-apply fork-local features one at a time, then cut over.

## 2. Why migrate

The fork is 1307 commits behind v2.0.64. Each week that gap grows. Staying on v1 means:

1. No access to new channels (the upstream `channels` branch is the official channel-distribution mechanism in v2)
2. No new MCP tools landing in upstream
3. No bug fixes
4. No `ncl` admin CLI
5. Compounding architectural divergence — our own 471 commits risk becoming an unmaintainable parallel implementation

v2 is upstream's bet on what NanoClaw is and will be. Continuing on v1 is choosing to maintain a parallel fork in perpetuity — a poor use of finite maintenance attention given that most of our fork-local features have known v2 homes (either as official skills, as upstream modules with the same purpose, or as fork-forever code that ports cleanly).

## 3. Current state

| Item | Value |
| --- | --- |
| Fork version | v1.2.71 |
| Forked from | upstream v1.2.19 (~2026-03-19, merge-base 91f17a1) |
| Upstream version | v2.0.64 |
| v2.0.0 release date | 2026-04-22 |
| Fork commits diverged | 471 |
| Upstream commits since divergence | 1307 |
| Tree delta vs current | ~600 files changed, +63k / -45k lines |
| Working tree | clean, branch `main` |
| Repo path | `/srv/apps/nanoclaw` |
| Upstream remote URL | `https://github.com/qwibitai/nanoclaw.git` (STALE — upstream rebranded to `nanocoai/nanoclaw` in v2.0.63; must update before migration) |

Operating environment:

- Linux server, systemd service (currently `nanoclaw.service`; v2 will be `nanoclaw-<install_slug>.service` per v2.0.63, slug = `sha1(project_root)[:8]`)
- Active channels: WhatsApp, Slack (heavy use), Gmail
- Fork-local Journal MCP integration via `JOURNAL_MCP_URL`
- Subscription-auth via `CLAUDE_CODE_OAUTH_TOKEN` (Claude Max billing — non-negotiable). On v1 this routes through the fork's custom credential proxy; on v2 it routes through OneCLI's Anthropic-typed secret (see §5).
- Active scheduled tasks (heavy use)
- User can tolerate downtime during cutover

## 4. What changes in v2

Full enumeration is in upstream's own doc: `upstream/main:docs/v1-to-v2-changes.md`. Summarized so the rest of this doc reads standalone:

1. **Entity model rewrite.** `registered_groups` (flat) → `agent_groups` + `messaging_groups` + `messaging_group_agents` (M:N). Privilege is now explicit via `users` / `user_roles`. Single `trigger_pattern` regex is split into four orthogonal columns: `engage_mode`, `engage_pattern`, `sender_scope`, `ignored_message_policy`.
2. **DB split.** Single `store/messages.db` → three: `data/v2.db` (central) + per-session `inbound.db` (host writes, container reads) + `outbound.db` (container writes, host reads). One writer per file.
3. **Scheduling.** Moved into session DBs as `messages_in` rows with `kind='task'`. Our `src/task-scheduler.ts` design is obsolete; v1 task data ports via `setup/migrate-v2/tasks.ts`.
4. **Credentials.** OneCLI Agent Vault is the default and has a first-class Anthropic-typed secret path that carries the same `sk-ant-oat01-…` subscription OAuth token v1's custom proxy uses. v2's installer (`setup/register-claude-token.sh`, `setup/auth.ts`) wires `claude setup-token` directly into `onecli secrets create --type anthropic`. The `/use-native-credential-proxy` skill exists on a sibling branch but is stale and unusable on v2.0.64 — see §5.
5. **Container runtime: Node → Bun** (in-container only; host stays Node + pnpm). `bun:sqlite` uses `$name`-prefixed params.
6. **Channels unbundled.** All channel adapters moved to a sibling `channels` branch. Trunk ships zero channels; install per-fork via `/add-<channel>` skills.
7. **Host process reshape.** Monolithic `src/index.ts` → `host-sweep.ts` + `host-core.ts` + `session-manager.ts` + `delivery.ts` + `webhook-server.ts`.
8. **Package manager.** npm → pnpm + workspaces, with `minimumReleaseAge: 4320` (3-day supply-chain wait).
9. **Service naming.** `nanoclaw.service` → `nanoclaw-<install_slug>.service`.
10. **CLAUDE.md composition.** v2 composes per-group CLAUDE.md from `.claude-shared.md` + `.claude-fragments/*.md` + `CLAUDE.local.md` at container spawn. Don't edit CLAUDE.md directly.

## 5. The critical finding (load-bearing)

**Pre-spike framing (now superseded).** Initial reading of v2 noted that `src/container-runner.ts` throws if OneCLI's gateway isn't applied — making OneCLI Agent Vault a hard precondition for container spawn. The pre-P1 plan assumed this required swapping OneCLI back out for the fork's custom credential proxy via the `/use-native-credential-proxy` skill branch, and the migration's load-bearing assumption was framed as "the skill works on v2."

**Post-P1 finding (load-bearing for v2).** The P1 spike (see [spike-notes.md](spike-notes.md) §3) inverted that framing on two points:

1. **The skill branch is dead on v2.0.64.** `upstream/skill/native-credential-proxy` tip is `3824f46` at 2026-03-28 — abandoned ~25 days before v2.0.0 (2026-04-22). Its latest code commit is in the v1.2.42 line. Attempting `git merge upstream/skill/native-credential-proxy` into v2 main produces conflicts across 5+ load-bearing files and effectively reverts the v2 architectural rewrite (+7641 / −19025 across 163 files). The `SKILL.md` shipping in v2.0.64 still instructs the operator to run that merge — that's an upstream documentation bug. Worth a GitHub issue against `nanocoai/nanoclaw` post-cutover. Anyone on v2 who runs the skill today hits the same merge conflicts the spike did.

2. **v2's OneCLI natively supports the Claude Max subscription path** — the thing the fork's custom proxy was preserving is preserved by OneCLI out of the box. `setup/register-claude-token.sh` runs `claude setup-token` to capture the `sk-ant-oat01-…` OAuth token, then stores it via `onecli secrets create --name Anthropic --type anthropic --value $token --host-pattern api.anthropic.com`. `setup/auth.ts:93-114` does the same for pre-existing tokens. `.claude/skills/init-onecli/SKILL.md` explicitly migrates `CLAUDE_CODE_OAUTH_TOKEN` from `.env` into the vault as `--type anthropic`. The same secret v1's proxy injects, v2's OneCLI MITM-substitutes — same SDK in the container (`@anthropic-ai/claude-agent-sdk` v0.2.138 in both), same wire shape, same three-part subscription contract: `sk-ant-oat01-…` token prefix + exchange endpoint `/api/oauth/claude_cli/create_api_key` + `anthropic-beta: oauth-2025-04-20` header. None of those depend on which proxy is in front; all flow through unchanged. Subscription billing is preserved at the SDK level, not at the proxy level.

The actual load-bearing assumption is therefore: **v2's OneCLI Anthropic-typed secret preserves Claude Max billing.** That holds by static analysis. The residual uncertainty (not physically observed in a wire capture or `/api/oauth/usage` lookup) is retirable as a P6 smoke-test verification — see implementation-plan §5 P6.

**Consequence for the plan.** The custom credential proxy is dropped, not ported. Decision 3 below (§7) is reversed; Alternative 3 (§8) — adopt OneCLI — becomes the chosen path. The W2.4 skill-merge step in the implementation plan is dead and is replaced with v2's standard `claude setup-token` → `onecli secrets create --type anthropic` flow during the install. This makes migration *lighter* than the pre-spike plan described: ~125 LOC of credential-proxy code retired rather than ported, no upstream skill branch to merge, no port collisions on `CREDENTIAL_PROXY_PORT`.

## 6. Our fork-local features and their v2 fate

| Fork-local feature | v2 fate |
| --- | --- |
| `src/credential-proxy.ts` | **RETIRE** — v2's OneCLI Anthropic-typed secret carries the same `sk-ant-oat01-…` OAuth token via MITM injection. Subscription routing preserved at the SDK level (token prefix + exchange endpoint + `anthropic-beta` header all survive the substitution). v2 install path: `claude setup-token` → `onecli secrets create --type anthropic`. No fork code to port. |
| `src/sender-allowlist.ts` | Overlaps with v2's `src/modules/permissions/` — decide layer-on-top vs port-rules-into |
| `src/status-tracker.ts` | Overlaps with v2's `src/modules/typing/` — likely retirable |
| `src/health.ts`, `src/health-server.ts`, `src/watchdog.ts` | No v2 equivalent — fork-local forever |
| `src/host-commands.ts` (`/usage`, `/status`) | `/status` overlaps with new `ncl` CLI; `/usage` likely fork-local forever |
| `src/remote-control.ts` | No v2 equivalent — re-port |
| `src/mount-security.ts` | v2 has `src/modules/mount-security/` — compare and pick one |
| Bundled Slack/WA/TG/Gmail in `src/channels/` | Install via `/add-<channel>` skills; re-port fork customizations onto v2's adapter shape |
| Journal MCP integration | Port from Node to Bun (`bun:sqlite` differs in param syntax) |

## 7. Decisions reached

1. **Strategy A: side-by-side install + data migration.** Clone fresh upstream v2 into `/srv/apps/nanoclaw-v2`, validate subscription-billing preservation via a throwaway spike (done in P1), use upstream's `migrate-v2.sh` to port v1 data, port fork-local features one at a time, cut over by stopping the v1 systemd unit and starting the v2 unit, keep v1 install in place as a tombstone for ~30 days.

   Rationale: minimises invasive code work, leverages the most upstream tooling possible (`migrate-v2.sh` + `/migrate-from-v1` skill), gives us a working v2 in a sibling directory we can poke at before cutover, and the rollback story is "stop v2, start v1" rather than "untangle merges."

2. **Spike-first (DONE).** Before any data migration, the load-bearing subscription-billing assumption was validated on a throwaway v2 checkout. Outcome captured in [spike-notes.md](spike-notes.md): subscription billing is preserved on v2, but via OneCLI's native Anthropic-typed secret rather than via the originally planned `/use-native-credential-proxy` skill (skill is stale at v1.2.42 and unmergeable on v2.0.64). The static-analysis conclusion has one residual uncertainty (no wire capture taken) which is retired as a P6 smoke-test step (implementation-plan W6.7) before cutover.

   Rationale: this was the load-bearing assumption in §5. Finding out the original mechanism (the skill) was dead in a throwaway sidecar cost ~one session; finding out after data migration would have cost a rollback. The redirect to OneCLI's native path was also discovered in the spike, making P2 lighter than originally planned.

3. **Adopt OneCLI on v2; drop the custom credential proxy.** Use v2's standard subscription auth flow: `claude setup-token` to capture (or carry over) the `sk-ant-oat01-…` OAuth token, then `onecli secrets create --type anthropic --value $token --host-pattern api.anthropic.com` to register it in the vault. The container reaches the Anthropic API via OneCLI's MITM, which substitutes the placeholder credential in-place. No fork-local proxy survives the migration.

   Rationale: the P1 spike established that v2's OneCLI Anthropic-typed secret preserves the full subscription-billing contract (token prefix + exchange endpoint + `anthropic-beta` header) at the SDK level. The `/use-native-credential-proxy` skill that would have swapped OneCLI back out is stale (last touched in v1.2.42; unmergeable on v2.0.64). Re-implementing a custom proxy on v2's host shape is unnecessary work. See §5 and [spike-notes.md](spike-notes.md) §3 for the analysis.

4. **Accept channel unbundling.** v2 ships zero channels in trunk; we re-install Slack, WhatsApp, Gmail via `/add-<channel>` skills on the v2 install.

   Rationale: we lose bundled-in-trunk convenience but gain clean upstream merges going forward. Slack tokens migrate via `.env`; scheduled task data ports via `migrate-v2.sh` — so the heavy-use channels (Slack, scheduled tasks) are not regressed by the unbundling.

5. **Update upstream remote to `nanocoai/nanoclaw` before doing anything else.** Our `upstream` remote still points at the old `qwibitai/nanoclaw` URL; v2.0.63 swept the rebrand.

   Rationale: the v2 migration tooling references `nanocoai/nanoclaw`. Tracking the old org will silently miss recent commits and cause confusing diffs throughout migration. Trivial to fix; should be the first action.

6. **Accept the one-way-door property of cutover.** Once v2 starts receiving real messages, those messages do not replay back into v1's `store/messages.db`. Reverting after cutover means accepting a context gap proportional to how long v2 was live.

   Rationale: there is no clean way around this without dual-writing messages, which is more complexity than it's worth for a migration we expect to succeed. Mitigation is operational: keep v1 install untouched for ~30 days, and briefly stop incoming messages during the cutover smoke test so the gap is bounded.

## 8. Alternatives considered and rejected

1. **Strategy B: clean-base replay via `/migrate-nanoclaw`.** Reset to upstream v2, replay each of our 471 fork commits against v2's architecture.

   Rejected because most of our fork commits are fork-local infrastructure (proxy, health, sender-allowlist, channel bundling) that has known v2 homes — an upstream skill, an upstream module with the same purpose, or fork-forever code. Replaying them as individual commits against a totally different host shape is ceremony, not value. Strategy A reaches the same end state with less per-commit conflict work.

2. **Strategy C: incremental merge via `/update-nanoclaw`.** Try to merge upstream piecewise on the existing tree.

   Rejected as dead on arrival. v2.0.0 alone removed or relocated most of the files our fork patches (`src/db.ts`, `src/message-loop.ts`, `src/host-commands.ts`, `src/channels/*`). The conflict surface would be near-total and the result would be a worst-of-both-worlds hybrid that doesn't match either upstream's v2 nor our v1 mental model.

3. **~~Adopt OneCLI Agent Vault.~~** (Previously rejected; now adopted — see Decision 3. Original rationale for rejection assumed OneCLI lacked a subscription path. The P1 spike showed OneCLI's Anthropic-typed secret carries the same `sk-ant-oat01-…` OAuth token v1's proxy uses, with subscription routing preserved by the SDK rather than by the proxy. The premise of the original rejection was wrong for v2.0.64. The alternative previously framed as the chosen path — keep the proxy via the upstream skill — turned out to be infeasible (skill stale at v1.2.42, unmergeable). Roles flipped.)

## 9. Non-goals

1. Not rewriting fork-local features that already work fine on v1. We port them onto v2 as-is; we do not redesign.
2. Not migrating v1 message history. Per upstream's design, the v1 `messages` and `chats` tables are not ported — only operationally-important state (env, groups, scheduled tasks, session continuity) moves forward.
3. ~~Not adopting OneCLI Vault.~~ Reversed post-P1: OneCLI Vault IS adopted on v2 — its Anthropic-typed secret carries the subscription OAuth token natively (see Decision 3 and Alternative 3). The custom credential proxy is the thing being retired.
4. Not bundling channels back into trunk. We accept the skill-distribution model.
5. Not changing our channel set during migration. Still WhatsApp, Slack, Gmail. Adding or removing channels is a separate task done before or after.
6. Not migrating in a single atomic step. Spike → install → port → smoke → cutover, each gated.
7. Not removing or upgrading any unrelated dependencies during migration. Only what v2 forces.

## 10. Risks accepted

1. **Context gap during cutover.** Messages received between "v2 start" and "v2 verified" do not replay back to v1. Mitigated by a brief incoming-message pause during smoke testing and a 30-day v1 tombstone.
2. **Manual fork-feature porting.** No automation; each fork-local feature is re-applied by hand atop v2's host shape. Reduced from the pre-spike framing: the credential proxy (the heaviest item, ~125 LOC + tests + bind-host detection) is now retired rather than ported, so P4 starts with the security-adjacent features (sender-allowlist, mount-security) and works outward through health/watchdog and the rest. The OneCLI subscription-billing assumption is verified in P6 as a smoke-test step (see implementation-plan §5 P6).
3. **CLAUDE.md and runbook rewrites.** Most file pointers in current CLAUDE.md are wrong for v2: no `src/db.ts`, no `src/message-loop.ts`, no `src/host-commands.ts`. The rewrite is mechanical but heavy.
4. **Bun runtime in container.** Our Journal MCP integration may need adjustments for Bun's quirks (`bun:sqlite` param syntax, import paths, possibly fetch/timer behaviour differences).
5. **Skill ecosystem reset.** Many fork-local skills (`/setup`, `/customize`, `/debug`, `/add-whatsapp`, etc.) target v1's structure and become irrelevant. v2's upstream skills target v2's structure. Expect to re-author or retire each fork-local skill individually.
6. **CI workflow rewrite.** `.github/workflows/ci.yml` calls `npm`; v2 is pnpm. The schema-version guard and skill-rebase guard logic also need to be re-evaluated against v2's three-DB layout.

## 11. References

- P1 spike findings (immutable record, supersedes §5/§6/§7/§8 of this doc where they conflict): [spike-notes.md](spike-notes.md)
- Upstream's own v1→v2 changes doc: `upstream/main:docs/v1-to-v2-changes.md` (canonical for the 10 architectural changes)
- This fork's divergence index: [../fork-divergence.md](../fork-divergence.md)
- Upstream migration entry point: `upstream/main:migrate-v2.sh`
- Upstream OneCLI subscription-auth wiring (load-bearing for v2): `upstream/main:setup/register-claude-token.sh`, `upstream/main:setup/auth.ts:93-114`, `upstream/main:.claude/skills/init-onecli/SKILL.md:138-141`
- Upstream post-migration skill: `upstream/main:.claude/skills/migrate-from-v1/SKILL.md`
- Upstream migration step modules: `upstream/main:setup/migrate-v2/{env,db,groups,sessions,tasks,channel-auth,select-channels}.ts`
- Upstream handoff file (script → skill): `upstream/main:logs/setup-migration/handoff.json` (generated at migration time)
- v2 container-runner OneCLI precondition (source of the original concern): `upstream/main:src/container-runner.ts:431`
- Upstream credential-proxy skill (historical — stale at v1.2.42, unmergeable on v2.0.64; documentation bug to file upstream): `upstream/main:.claude/skills/use-native-credential-proxy/SKILL.md` on branch `upstream/skill/native-credential-proxy` (tip commit 3824f46, 2026-03-28)
- This fork's credential-proxy docs (kept for reference / re-implementation if OneCLI ever proves insufficient): [../credential-proxy.md](../credential-proxy.md), [../claude-subscription-auth.md](../claude-subscription-auth.md). Comprehensive ingredient list for v2 re-implementation also captured in [spike-notes.md](spike-notes.md) §4.
- v2 service naming change: upstream tag v2.0.63
- Upstream org rebrand (`qwibitai` → `nanocoai`): upstream tag v2.0.63
