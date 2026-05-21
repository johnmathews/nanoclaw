# Spike notes (P1)

**Date:** 2026-05-21
**Outcome:** **PASS WITH CAVEATS** — the load-bearing assumption (v2 supports Claude Max subscription billing without "extra usage") is true, but **via a different mechanism than the plan called for.** The plan's W2.4 / W4.x path of merging `upstream/skill/native-credential-proxy` is dead and the motivation document's Decision 3 is invalidated for v2.

The migration is still feasible. P2 cannot start without first revising the motivation doc and the implementation plan.

---

## 1. What the spike was supposed to validate

Per [motivation-and-context.md](motivation-and-context.md) §5 (load-bearing finding) and [implementation-plan.md](implementation-plan.md) §5 P1, the spike was to prove:

1. The `/use-native-credential-proxy` skill can be applied to a fresh v2 install.
2. Subscription billing via `CLAUDE_CODE_OAUTH_TOKEN` survives end-to-end on v2 (oauth token → exchange → container → reply).

Either both hold → P2 can start as written. Either fails → STOP and reassess.

## 2. What actually happened

### W1.1 — Clone (PASS)

`git clone https://github.com/nanocoai/nanoclaw.git /srv/apps/nanoclaw-v2-spike` succeeded at v2.0.64 (commit `0683c6e`). All expected files present: `setup.sh`, `nanoclaw.sh`, `migrate-v2.sh`, `.claude/skills/use-native-credential-proxy/SKILL.md`.

Surprise (low-impact): `/srv/apps` is root-owned on this host. Required a `sudo mkdir + chown` step the user ran by hand before I could clone. P2's W2.1 will hit the same friction at `/srv/apps/nanoclaw-v2/`.

### W1.2 — Base install (SUBSTITUTED)

`nanoclaw.sh` / `setup.sh` are heavily interactive (pre-flight prompts via `/dev/tty`, OneCLI install, channel selection, service registration). They cannot run cleanly under the Claude Code Bash tool.

For the spike's specific purpose (validate the credential path; we explicitly skipped channels via the W1.5' deviation; OneCLI itself was the thing under test) the full installer is overkill. I substituted:

- `npm install -g pnpm` (lands at `/home/john/.npm-global/bin/pnpm`, **not on default PATH**; every spike command needed `PATH="/home/john/.npm-global/bin:$PATH"` prefix). pnpm v11.1.3 installed; spike's own `package.json` later pulled in pnpm v10.33.0 to honor the lockfile.
- `pnpm install` in spike dir (succeeded; node_modules populated).

This unblocked subsequent steps without touching OneCLI install, systemd unit, or any channel.

### W1.3 — Apply credential-proxy skill (HARD FAIL → REDIRECTED)

This is the spike's main finding.

**The skill branch is stale and incompatible with v2.0.64:**

- `upstream/skill/native-credential-proxy` tip is **`3824f46` at 2026-03-28** ("merge: catch up with upstream main").
- v2.0.0 launched 2026-04-22. The branch was abandoned ~25 days **before** v2 existed.
- Latest code commit on the branch is `90af26a` ("chore: remove claw skill test") in the **v1.2.42 line** of the codebase.
- `git merge upstream/skill/native-credential-proxy` into v2 main produces conflicts in 5+ load-bearing files (`src/container-runner.ts`, `src/index.ts`, `src/config.ts`, `setup/verify.ts`, `src/container-runner.test.ts`). Full diff is **+7641 / −19025 across 163 files** — effectively reverts the v2 architectural rewrite.
- Notably, the `SKILL.md` shipped with v2.0.64 (last edited `2026-05-15`, commit `b8d7777`) still tells the operator to run `git merge upstream/skill/native-credential-proxy`. **This is an upstream documentation bug** — the skill instructions reference a branch that wasn't maintained through the v2 migration.

The merge was aborted (`git merge --abort`); spike returned to clean tree.

**No other upstream branch contains the credential-proxy skill.** `git ls-remote upstream` listed every skill branch and none target v2 architecture. There is a `refs/heads/v2` branch but it was the development branch FOR v2 and was merged into main long ago — currently behind main.

### W1.4 — Set non-colliding ports (DROPPED)

Mooted by W1.3's redirect. The custom proxy that would have listened on 4001 is no longer in scope.

### W1.5' — Direct SDK validation (REDIRECTED)

Originally planned (per user's W1.5' deviation) to use one of three approaches against a working credential proxy. Without a working proxy, none of the three apply.

Substituted with: **read v2's OneCLI integration and confirm by static analysis that subscription billing routes correctly.**

### W1.6 — Observe credential proxy on real call (REDIRECTED)

See W1.5'. Replaced with static-analysis verification of the actual v2 path.

### W1.7 — Decision gate (this section)

See §3 below for the explicit outcome and recommendation.

---

## 3. Critical finding: v2 already supports Claude Max subscription billing natively

The motivation document's Decision 3 ("Keep credential proxy; do NOT adopt OneCLI") was based on the claim:

> OneCLI doesn't (today) provide subscription billing through the same path our credential proxy does.

**This is wrong for v2.** v2's OneCLI has a first-class subscription path:

- `setup/auto.ts:724-750` — auth step UI offers "Sign in with my Claude subscription" as option #1, recommended for Pro/Max.
- `setup/register-claude-token.sh` — comment: "Register a Claude subscription OAuth token with OneCLI — the *only* auth path that needs a TTY break in the flow." Runs `claude setup-token` to capture the `sk-ant-oat…AA` token, then:
  ```
  onecli secrets create --name Anthropic --type anthropic --value $token --host-pattern api.anthropic.com
  ```
- `setup/auth.ts:93-114` — `createAnthropicSecret()` does the same `onecli secrets create --type anthropic` call when the operator pastes a pre-existing token.
- `.claude/skills/init-onecli/SKILL.md:138-141` — explicitly migrates `CLAUDE_CODE_OAUTH_TOKEN` from `.env` into the vault as `--type anthropic`.

In other words: **the SAME `sk-ant-oat01-…` OAuth token v1's credential proxy uses, v2's OneCLI stores in its vault.** Both substitute it on outbound requests to `api.anthropic.com`.

### Does this preserve Claude Max billing (no "extra usage")?

**Yes, with high confidence based on static analysis. Not physically verified with packet capture.**

Per v1's [docs/credential-proxy.md](../credential-proxy.md) §4.3, subscription routing is a **three-part contract**, none of which the proxy itself controls:

1. **Token prefix `sk-ant-oat01-…`** signals "subscription-bound" to Anthropic. This is the token type v2 stores.
2. **Exchange endpoint `/api/oauth/claude_cli/create_api_key`** is the subscription-aware route. The SDK calls this regardless of which proxy intercepts.
3. **`anthropic-beta: oauth-2025-04-20` header** is Anthropic's "route to subscription" flag. The SDK adds it; neither v1's proxy nor (per its MITM model) OneCLI strips or rewrites it.

v2's container agent-runner uses the same `@anthropic-ai/claude-agent-sdk` package (currently `0.2.138` — per `container/agent-runner/bun.lock`) as v1. The SDK's wire-level behavior — including the exchange dance, the beta header, and the choice of `Authorization: Bearer` for the exchange vs `x-api-key` for inference — is identical between v1 and v2. The only thing that differs is the interceptor:

- **v1:** Plain HTTP reverse proxy at `docker0:3001`. Container's `ANTHROPIC_BASE_URL` points at it. Proxy substitutes the Bearer value.
- **v2:** OneCLI MITM proxy. Container env: `HTTPS_PROXY=http://onecli`, `NODE_EXTRA_CA_CERTS=<onecli CA>`. OneCLI terminates TLS, inspects, substitutes credential, re-encrypts to upstream.

OneCLI's SDK README says: "Inspects the request and injects real credentials." Per `init-onecli/SKILL.md` GitHub-troubleshooting section, OneCLI explicitly cares about preserving auth format ("GitHub's git smart HTTP requires Basic, not Bearer; these must be configured as separate secrets"). That tells us OneCLI is auth-format-aware and substitutes-in-place — it does NOT convert a Bearer to an x-api-key or vice versa.

Conclusion: requests carrying `Authorization: Bearer placeholder` + `anthropic-beta: oauth-2025-04-20` go out as `Authorization: Bearer sk-ant-oat01-<real>` + `anthropic-beta: oauth-2025-04-20`. Subscription routing is preserved. Requests bill against the Max rate-limit window (5h / 7d / 7d-opus / 7d-sonnet), not against "extra usage" — unless the operator has explicitly enabled `extra_usage.is_enabled` on the Anthropic account AND a window is exhausted, in which case the spillover happens regardless of which proxy is in place. The proxy controls *which billing pipeline*; it does not control opt-in spillover.

### Residual uncertainty (worth retiring before cutover)

I have NOT physically observed an end-to-end request through v2's OneCLI to confirm the beta header survives and that Anthropic's response is subscription-billed. To retire this caveat, P2 should include a wire-capture check during smoke testing — either:

- (a) `tcpdump`/`mitmproxy`-style capture of the actual outbound request to api.anthropic.com from a v2 container, or
- (b) Examination of the `/api/oauth/usage` response after a few test requests, looking for the request to land in `five_hour` / `seven_day` quota bucket (subscription) vs the `extra_usage` bucket (per-token API).

A v1-equivalent `/usage` lookup is the cheaper of the two and is already documented in `src/host-commands.ts:230` (v1) — porting this to v2 would let us audit billing routing without packet capture. Suggest this becomes a P6 smoke-test verification (or P4 if the host-command port lands earlier).

---

## 4. V1 credential proxy — comprehensive reference for re-implementation if needed

Per user request: document v1's credential-proxy implementation in detail so it can be reimplemented on v2 if the OneCLI path turns out not to work.

**The canonical reference is [docs/credential-proxy.md](../credential-proxy.md)** (15 sections, ~800 lines, written specifically for "someone building a similar credential-isolation layer for an SDK they don't control"). Quick map:

| Concern | v1 file | Section in docs/credential-proxy.md |
|---|---|---|
| Proxy implementation (HTTP server, ~120 LOC) | `src/credential-proxy.ts` | §6.1, §6.2 |
| Tests | `src/credential-proxy.test.ts` | §9 |
| Bind-host detection | `src/container-runtime.ts:detectProxyBindHost()` | §6.4 |
| Container env wiring | `src/container-runner.ts` | §6.3 |
| Token refresh logic | `src/host-commands.ts:getValidAccessToken()` | §7 |
| Token-refresh endpoint | `console.anthropic.com/v1/oauth/token` | §7 |

### Required ingredients to re-implement on v2

If v2's OneCLI path proves insufficient, this is the minimum surface needed to bring v1's proxy forward:

1. **SDK:** `@anthropic-ai/claude-agent-sdk` (unmodified). Already in v2 (`container/agent-runner/bun.lock`: v0.2.138). Configured via `ANTHROPIC_BASE_URL` env var only.

2. **Tokens (host `.env`):**
   - `ANTHROPIC_API_KEY` — pay-per-use API key (sk-ant-api03-...). If set, selects api-key mode.
   - `CLAUDE_CODE_OAUTH_TOKEN` — Claude Max OAuth token (sk-ant-oat01-...). Selects oauth mode when no API key.
   - `ANTHROPIC_AUTH_TOKEN` — fallback alias for `CLAUDE_CODE_OAUTH_TOKEN`.
   - `ANTHROPIC_BASE_URL` — optional upstream override; defaults to `https://api.anthropic.com`.

3. **Proxy behavior (api-key mode):** Strip incoming `x-api-key`; inject `x-api-key: <ANTHROPIC_API_KEY>`. Unconditional, every request.

4. **Proxy behavior (oauth mode):** ONLY when the incoming request has an `Authorization` header, replace it with `Authorization: Bearer <CLAUDE_CODE_OAUTH_TOKEN>`. For all other requests (the post-exchange `x-api-key` inference traffic), pass through untouched. Critically — the proxy does **not** add the `anthropic-beta: oauth-2025-04-20` header; that comes from the SDK and flows verbatim through the proxy.

5. **Hop-by-hop header stripping:** delete `connection`, `keep-alive`, `transfer-encoding` per RFC 2616 §13.5.1.

6. **Host header rewrite:** set `host: api.anthropic.com` so SNI / HTTP/1.1 host-routing works at upstream.

7. **Response streaming:** `upstreamRes.pipe(clientRes)` — must not buffer responses (breaks SSE / token streaming).

8. **Bind-host logic (Linux bare metal):** bind to the `docker0` bridge IP, NOT `0.0.0.0` and NOT `127.0.0.1`. Containers can reach docker0; non-Docker host processes cannot.

9. **Container env injection (in `container-runner.ts`):**
   - `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>`
   - `ANTHROPIC_API_KEY=placeholder` (api-key mode) OR `CLAUDE_CODE_OAUTH_TOKEN=placeholder` (oauth mode).
   - `--add-host=host.docker.internal:host-gateway` on Linux Docker.

10. **Token refresh (host-side, separate from proxy):** OAuth refresh endpoint `console.anthropic.com/v1/oauth/token`, client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code's OAuth client ID). Refreshed credentials persist to `~/.claude/.credentials.json`. **Known weakness:** v1's proxy doesn't read this file post-startup; refresh logic doesn't push to the proxy. See `docs/credential-proxy.md` §11.1.

### Threats this design defends against (matters for security review on v2 OneCLI port)

- Real long-lived credentials never enter container env (`/proc/self/environ`, `env`, debugger output, etc.).
- OAuth token crosses the wire exactly once per container session (the exchange call); inference traffic carries only the short-lived (~minutes) temp key.
- Bind-host policy (docker0 on Linux) prevents non-container host processes from using the proxy as a credential-laundering relay.

OneCLI's MITM model achieves similar properties via TLS-termination + injection. Functionally equivalent in terms of "container never sees real long-lived secret." Different blast radius from a compromise of the proxy itself (OneCLI is a separate daemon with its own auth → broader, but also more isolation), but for a single-host single-operator install the trade is acceptable.

---

## 5. Plan revisions needed before P2

These are the load-bearing pieces of [motivation-and-context.md](motivation-and-context.md) and [implementation-plan.md](implementation-plan.md) that must be updated. Without these updates, P2 will fail at W2.4 in the same way the spike failed at W1.3.

### motivation-and-context.md

- **§5 ("The critical finding (load-bearing)") needs rewriting.** The current text says the skill swaps OneCLI for the credential proxy. Reality on v2.0.64: the skill branch is stuck at v1.2.42 and unmergeable. The actual load-bearing fact is that **v2's OneCLI natively supports the Claude Max OAuth subscription path** (`onecli secrets create --type anthropic --value sk-ant-oat01-…`). The migration's load-bearing assumption is "v2 preserves subscription billing" — that's true, but via OneCLI, not via a custom proxy.
- **§6 fork-local-features table:** `src/credential-proxy.ts` row says "RESOLVED via `/use-native-credential-proxy` skill." Change to: "RETIRE — v2's OneCLI Anthropic-typed secret carries the same `sk-ant-oat01-…` OAuth token via MITM injection. Subscription routing preserved at the SDK level (token prefix + exchange endpoint + beta header all survive)."
- **§7 Decision 3 ("Keep the credential proxy; do NOT adopt OneCLI") needs full reversal.** New decision: "Adopt OneCLI on v2. Drop the custom credential proxy. Subscription billing routes through OneCLI's Anthropic-typed secret. Migrate `.env`'s `CLAUDE_CODE_OAUTH_TOKEN` to `onecli secrets create --type anthropic` during the install."
- **§8 alternative 3 ("Adopt OneCLI Agent Vault — Rejected because...") needs reversal** for the same reason as Decision 3.

### implementation-plan.md

- **§2 line 3 ("Keep credential proxy: route through the proxy via the upstream skill"):** delete; replace with "Adopt OneCLI for subscription auth."
- **P1 in §5:** rewrite to reflect the actual spike outcome — the skill-merge step W1.3 is dead.
- **W2.4 ("Apply `/use-native-credential-proxy` skill"):** delete the work unit. Its replacement is "use v2's standard auth flow: subscription path via `claude setup-token` → `onecli secrets create --type anthropic`."
- **W4 (port credential proxy):** remove from the port checklist. Add a new W4.x: **"Wire-verify subscription billing on v2"** — after the first real container spawn, query `api.anthropic.com/api/oauth/usage` (or v2's equivalent) and confirm requests land in the `five_hour` / `seven_day` buckets, NOT in `extra_usage`. This is the retiring step for §3 above.
- **P0 W0.5 fork-local-inventory.md:** update `src/credential-proxy.ts` row Disposition from "port" to "retire". (See `docs/v2-migration/fork-local-inventory.md` — already exists from P0; needs editing.)
- **§10 Risks accepted:** the "Manual fork-feature porting" risk should be reduced — credential proxy was the heaviest item and is now retired, not ported.

---

## 6. Observations / surprises (for future spike-style work)

- **The OneCLI installer is invasive but non-destructive to v1.** It drops a binary at `~/.local/bin/onecli` and starts a daemon. The daemon is separate from any NanoClaw service. For a parallel install (P2), running OneCLI's installer on the host once is shared between v1 and v2 — v1 never used it, so it's a true add, not a conflict. But this is a host-state side-effect that survives spike teardown if installed.
- **The credential-proxy SKILL.md (currently shipping in v2.0.64) is outdated upstream documentation.** Worth a GitHub issue against `nanocoai/nanoclaw` once we're on v2 — the skill points to a branch that no longer applies. Pending that, anyone on v2 who runs the skill will get the same merge conflicts we did.
- **`scripts/test-v2-host.ts`** in v2 is a useful direct invocation surface for end-to-end container-spawn tests (creates a central DB, routes an inbound message, spawns a real container, waits for outbound). Good candidate for re-using as the P6 smoke test (replaces v1's `scripts/smoke-test.ts`).
- **v2's slug-suffixed systemd unit name** for the spike at `/srv/apps/nanoclaw-v2-spike` resolves to `nanoclaw-v2-10a02948.service` (sha1(path)[:8]). The eventual P2 install at `/srv/apps/nanoclaw-v2/` will resolve to a different slug (`9c12bd9b` per `node -e "..."`); v1's `nanoclaw.service` is non-suffixed and won't collide.
- **`/srv/apps` is root-owned on this host.** Both the spike clone and P2's `git clone ... /srv/apps/nanoclaw-v2` require a manual `sudo mkdir + chown` step before the clone can land. Worth noting in P2's W2.1 action block.
- **`pnpm` is installed at `~/.npm-global/bin/pnpm` and `~/.bashrc` adds it to PATH, but the Claude Code Bash tool doesn't source `.bashrc`.** Every pnpm call in P2 will need `PATH="/home/john/.npm-global/bin:$PATH"` or an explicit absolute path.

---

## 7. W1.7 outcome and recommendation

**W1.7 outcome:** PASS with caveats.

- **Load-bearing assumption** (v2 supports Claude Max subscription billing without "extra usage"): **TRUE** by static analysis. Same SDK, same wire shape, same three-part subscription contract (`sk-ant-oat01-…` prefix + exchange endpoint + `anthropic-beta: oauth-2025-04-20`), all preserved through OneCLI's substitute-in-place MITM. Residual: not physically verified with packet capture / `/api/oauth/usage` lookup — recommend that becomes a P6 smoke-test check.
- **Proposed mechanism** (apply the `/use-native-credential-proxy` skill on v2): **DEAD.** Branch is stuck at v1.2.42 and unmergeable. The skill's `SKILL.md` ships in v2.0.64 but its instructions don't work.
- **Actual viable mechanism** (use v2's standard OneCLI subscription auth path): **available, documented, in-tree** (`setup/register-claude-token.sh`, `setup/auth.ts`, `.claude/skills/init-onecli/SKILL.md`). Simpler than expected — no custom proxy required.

**Recommendation:** **NOT READY for P2 as written.** Plan revisions in §5 above must happen before P2 starts. Once those land, P2 is straightforward and lighter than the current plan describes (no skill-merge step, no credential-proxy port).

---

## 8. Spike teardown

- Spike dir contents at `/srv/apps/nanoclaw-v2-spike/` removed (clone + node_modules wiped).
- Empty directory `/srv/apps/nanoclaw-v2-spike` remains — removing it requires write permission on `/srv/apps` (root-owned). User runs `sudo rmdir /srv/apps/nanoclaw-v2-spike` to complete teardown.
- No docker containers spawned (the credential-proxy test path was abandoned before W1.6).
- No systemd unit registered (full installer was substituted with `pnpm install` only).
- No OneCLI daemon installed (deliberately avoided to keep host state clean; this means subscription routing verification is paper-only as noted in §3).
- `pnpm` was installed globally at `~/.npm-global/bin/pnpm` (v11.1.3). Not removed — needed for P2 anyway. On PATH only via `~/.bashrc`, NOT under Claude Code Bash tool's default PATH.
- v1 production service `nanoclaw.service` was never touched during the spike. v1's `.env` was read once (for reference; never copied since we didn't reach the credential-export step).
