# NanoClaw v1 → v2 Migration: Implementation Plan

**Status:** active, **mid-migration**. **Last updated:** 2026-05-22 (post-W4.5). **Supersedes:** pre-P1 §2 line 3, §5 P1 (rewritten as historical record), §5 W2.4 (deleted), §5 P4's credential-proxy work (deleted). **Post-P3** further supersedes: §5 W3.5 (must SKIP), §5 W3.6 (skill crosses the cutover), §5 P7 (collapsed), §6 kill criterion #1 (retired). **Post-W4.0** supersedes: §5 W4.0 (DONE — see [p3-notes.md](p3-notes.md) §9 + [slack-inbound-decision.md](slack-inbound-decision.md)). **Post-W4.3** supersedes: §5 W4.3 (DONE — see [p3-notes.md](p3-notes.md) §10). **Post-W4.5** supersedes: §5 W4.5 (DONE — see [p3-notes.md](p3-notes.md) §11), new W4.5.1 added. See [spike-notes.md](spike-notes.md) §5 (P1) and [p3-notes.md](p3-notes.md) §5 + §9 + §10 + §11 for the source of these revisions.

> ⚠️ **Where we are right now:** P0 → P3 are complete; **W4.0 (Slack inbound), W4.3 (health/watchdog), and W4.5 (`/usage`) are DONE** as of 2026-05-22. v2 is **live in production** at `/srv/apps/nanoclaw-v2/` (`nanoclaw-v2-787facac.service`, active+enabled, `Type=notify`+`WatchdogSec=30s`). v1 is stopped+disabled. The P7 one-way-door cutover effectively happened during P3 W3.6 via `/migrate-from-v1`'s smoke-test phase — see [p3-notes.md](p3-notes.md) §3.1. `/usage` available as both `ncl usage` (CLI) and `/usage` (chat) — see [p3-notes.md](p3-notes.md) §11. **Next: W4.4 mount-security audit**, then W4.5.1 `/status` chat fold-in, then audit-style work units. WhatsApp + Slack + scheduled tasks + Gmail/GCal MCPs all working. Subscription billing structurally verified. Follow-ups surfaced: Slack interactivity port; chat-sdk-bridge audit; v2 installer-template watchdog patch.

**See also:** [motivation-and-context.md](motivation-and-context.md) for why, what decisions were made, and what alternatives were rejected. Read that first if this is your first time touching this plan. [spike-notes.md](spike-notes.md) captures the P1 spike that inverted the credential-proxy approach.

---

## 1. TL;DR

Target state: this fork running on upstream NanoClaw v2.0.64+ with all fork-local features (Journal MCP, sender allowlist, health/watchdog, remote-control, `/usage`, Slack threading customizations) re-ported atop v2's modular host architecture. **Subscription billing is handled by v2's OneCLI vault, not by the fork's custom credential proxy** — the proxy is retired (P1 spike outcome; see [spike-notes.md](spike-notes.md) §3). Strategy is parallel install (v1 keeps running while v2 is built next to it). The P1 spike validating subscription billing on v2 is done; P6 includes a wire-level verification step before cutover. Eight phases (P0 preflight → P7 cutover → P8 hardening). Rough effort: parallel install 1 session, port 2 sessions, cutover 1 session, hardening 1 session. **Cutover (P7) is a one-way door**: once the v2 systemd unit takes the channels, messages received on v2 do not replay to v1.

## 2. Decisions in one line each

1. **Strategy A**: parallel install at `/srv/apps/nanoclaw-v2/`, not in-place rebase.
2. **Spike-first** (DONE): the P1 spike proved subscription billing is preserved on v2 — but via OneCLI's native Anthropic-typed secret, not via the originally planned `/use-native-credential-proxy` skill (which is stale at v1.2.42 and unmergeable on v2.0.64). See [spike-notes.md](spike-notes.md).
3. **Adopt OneCLI for subscription auth**: drop the fork's custom credential proxy. `claude setup-token` → `onecli secrets create --type anthropic` carries the same `sk-ant-oat01-…` token, same SDK, same subscription-routing contract.
4. **Accept channel unbundling**: v2's per-channel skill model is fine; we re-port our customizations onto each adapter.
5. **Update remote URL first**: switch upstream from `qwibitai/nanoclaw` to `nanocoai/nanoclaw` as P0's very first step.
6. **Accept context gap at cutover**: agent session history does not migrate; user starts fresh sessions on v2.

## 3. Non-goals

1. Not rewriting fork features from scratch — port what exists.
2. Not migrating in-flight Claude Agent SDK session state (`.jsonl` session files). User accepts a fresh-session reset at cutover.
3. Not preserving the v1 systemd unit name (`nanoclaw.service`) — v2's slug-suffixed unit name is fine.
4. Not bundling Discord, Telegram, or other unused channels into v2's `main` — only WhatsApp/Slack/Gmail (current production).
5. Not contributing fork-local features back to upstream as part of this migration. That's separate work.
6. Not maintaining v1 ↔ v2 schema compatibility after cutover.

## 4. Prerequisites

Run in order. Do not skip.

1. Working tree at `/srv/apps/nanoclaw` is clean (`git status --porcelain` returns empty).
2. Live backup of `store/messages.db` taken (see W0.3).
3. Live backup of `data/` (sessions, status-tracker JSON, remote-control state) taken (see W0.3).
4. Live backup of `groups/` (per-group `config.json` + `CLAUDE.md`) taken (see W0.3).
5. Git tag `pre-v2-migration-<YYYYMMDD>` created on `main` (see W0.2).
6. Upstream remote URL updated to `https://github.com/nanocoai/nanoclaw.git` (was `qwibitai/nanoclaw`) (see W0.1).
7. Disk: at least 2× current install size free. Run `du -sh /srv/apps/nanoclaw` and confirm `df -h /srv/apps` has headroom.
8. `~/.config/nanoclaw/sender-allowlist.json` and `~/.config/nanoclaw/mount-allowlist.json` backed up (these live outside the repo and are not captured by git).
9. This entire document read once end-to-end before executing W0.1.

---

## 5. Phase-by-phase plan

### P0: Preflight

All P0 work happens in `/srv/apps/nanoclaw`.

#### W0.1: Update upstream remote URL

**Action:**

```bash
cd /srv/apps/nanoclaw
git remote set-url upstream https://github.com/nanocoai/nanoclaw.git
git fetch upstream --tags
```

**Verification:**

```bash
git remote -v | grep upstream
# Expect: upstream  https://github.com/nanocoai/nanoclaw.git (fetch)
#         upstream  https://github.com/nanocoai/nanoclaw.git (push)
git log upstream/main --oneline -1
# Expect: a commit message referencing v2.0.64 or later
```

**Rollback:**

```bash
git remote set-url upstream https://github.com/qwibitai/nanoclaw.git
```

**Notes:**
Upstream rebranded from `qwibitai` to `nanocoai` per v2.0.63. The old URL may still resolve via GitHub redirect, but pinning the new canonical URL avoids surprises if/when the redirect is removed.

---

#### W0.2: Create git backup tag and branch

**Action:**

```bash
cd /srv/apps/nanoclaw
TAG="pre-v2-migration-$(date -u +%Y%m%d)"
git tag -a "$TAG" -m "Snapshot before v1.2.71 → v2 migration"
git branch "$TAG-branch"
```

**Verification:**

```bash
git tag -l | grep pre-v2-migration
git branch | grep pre-v2-migration
git rev-parse "$TAG"  # prints commit SHA
```

**Rollback:**

```bash
git tag -d "$TAG"
git branch -D "$TAG-branch"
```

**Notes:**
Local-only tag. If the operator wants offsite durability they can `git push origin "$TAG"` after the migration is complete and validated.

---

#### W0.3: Back up live data

**Action:**

```bash
TS=$(date -u +%Y%m%d-%H%M%S)
mkdir -p ~/backups
tar --warning=no-file-changed -czf ~/backups/nanoclaw-pre-v2-${TS}.tar.gz \
  -C /srv/apps/nanoclaw store data groups \
  -C "$HOME/.config" nanoclaw
```

**Verification:**

```bash
ls -lh ~/backups/nanoclaw-pre-v2-*.tar.gz
tar -tzf ~/backups/nanoclaw-pre-v2-${TS}.tar.gz | head -20
tar -tzf ~/backups/nanoclaw-pre-v2-${TS}.tar.gz | grep -E "(messages.db|sender-allowlist.json|mount-allowlist.json)"
# All three filenames should appear
```

**Rollback:**

```bash
# To restore (only if v1 was destructively modified — should not happen at this stage):
cd /srv/apps/nanoclaw
tar -xzf ~/backups/nanoclaw-pre-v2-${TS}.tar.gz
```

**Notes:**
`tar --warning=no-file-changed` is defensive — `store/messages.db` may be written to during backup while the service is running. For a fully consistent snapshot, stop the service first (`systemctl --user stop nanoclaw.service`), back up, then restart. We accept a slightly fuzzy backup here because W3.1 takes a clean stopped-service backup before the destructive step.

---

#### W0.4: Capture tooling versions

**Action:**

```bash
mkdir -p /srv/apps/nanoclaw/docs/v2-migration
{
  echo "# Tooling versions captured $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "## Node"; node --version
  echo "## npm"; npm --version
  echo "## pnpm"; (command -v pnpm && pnpm --version) || echo "not installed"
  echo "## Bun"; (command -v bun && bun --version) || echo "not installed"
  echo "## Docker"; docker --version
  echo "## Docker server"; docker version --format '{{.Server.Version}}'
  echo "## systemd"; systemctl --version | head -1
  echo "## OS"; cat /etc/os-release | grep PRETTY_NAME
} > /srv/apps/nanoclaw/docs/v2-migration/tooling-baseline.md
```

**Verification:**

```bash
cat /srv/apps/nanoclaw/docs/v2-migration/tooling-baseline.md
# Every section populated; no blank versions
```

**Rollback:** n/a (read-only / write-only-to-new-file).

**Notes:**
v2 uses pnpm and Bun in places where v1 used npm. Capturing the baseline lets us tell whether a later failure is caused by a tooling drift vs. a code issue.

---

#### W0.5: Audit fork-local files and produce porting inventory

**Action:**

```bash
cd /srv/apps/nanoclaw
# Read docs/fork-divergence.md as the index, then for each fork-local file:
{
  echo "# Fork-local file inventory for v2 porting"
  echo
  echo "Captured: $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git rev-parse HEAD)"
  echo
  echo "| File | LOC | Phase | Disposition |"
  echo "| --- | --- | --- | --- |"
  for f in \
    src/credential-proxy.ts \
    src/sender-allowlist.ts \
    src/status-tracker.ts \
    src/health.ts \
    src/health-server.ts \
    src/watchdog.ts \
    src/mount-security.ts \
    src/host-commands.ts \
    src/remote-control.ts \
    src/transcription.ts; do
    if [ -f "$f" ]; then
      loc=$(wc -l < "$f")
      echo "| $f | $loc | TBD | TBD |"
    fi
  done
} > docs/v2-migration/fork-local-inventory.md
```

Then manually edit the file: for each row, fill in **Phase** (which P4 work unit it maps to) and **Disposition** (`port`, `retire-replaced-by-v2`, `defer`).

**Verification:**

```bash
cat /srv/apps/nanoclaw/docs/v2-migration/fork-local-inventory.md
# Every row has Phase and Disposition filled in (no TBD)
wc -l /srv/apps/nanoclaw/docs/v2-migration/fork-local-inventory.md
```

**Rollback:** n/a (new file only).

**Notes:**
Use `docs/fork-divergence.md` as the index of fork-local files — that document is the canonical inventory of what differs from upstream. This work unit converts that index into a porting checklist for P4. Don't skip: if you skip, P4 has no roadmap and will drift.

---

### P1: Spike — validate subscription billing on v2 (DONE 2026-05-21)

**Status:** complete. **Outcome:** PASS with caveats — see [spike-notes.md](spike-notes.md) for the immutable record.

**Original purpose** (pre-spike framing): prove `CLAUDE_CODE_OAUTH_TOKEN` subscription-auth survives on v2 via the `/use-native-credential-proxy` skill before any data migration. If false, the whole plan is invalidated.

**Actual outcome.** The load-bearing assumption holds, but the mechanism inverted:

- **PASS:** v2 supports Claude Max subscription billing without "extra usage" — same SDK, same `sk-ant-oat01-…` token prefix, same `/api/oauth/claude_cli/create_api_key` exchange, same `anthropic-beta: oauth-2025-04-20` header. Routes through v2's OneCLI Anthropic-typed secret. Verified by static analysis (not physical wire capture — see P6 W6.7).
- **DEAD:** the `/use-native-credential-proxy` skill cannot be applied to v2.0.64. The branch tip (`3824f46`, 2026-03-28) is from the v1.2.42 line and was abandoned ~25 days before v2.0.0 shipped. `git merge upstream/skill/native-credential-proxy` produces conflicts across 5+ load-bearing files (+7641 / −19025 across 163 files) — effectively reverts the v2 rewrite. The skill's `SKILL.md` is still shipped in v2.0.64 and still instructs the operator to run this merge; this is an upstream documentation bug. Worth a post-cutover GitHub issue.
- **REDIRECTED:** the planned W1.4 port-shift (4001/4002 for the proxy), W1.5 throwaway-channel, and W1.6 end-to-end test were either rendered moot (no custom proxy to shift ports for) or substituted with static analysis of v2's OneCLI integration. Spike teardown left `/srv/apps/nanoclaw-v2-spike` empty (clone wiped); pnpm at `~/.npm-global/bin/pnpm` was kept since P2 needs it anyway.

**Consequence:** the W2.4 skill-merge step in P2 is deleted. Subscription auth on v2 is handled by v2's standard installer path (`claude setup-token` → `onecli secrets create --type anthropic`). The fork's `src/credential-proxy.ts` is retired, not ported.

**Residual uncertainty retired in P6:** the subscription-routing conclusion is paper-only (no wire capture). W6.7 adds a `/api/oauth/usage` lookup after the first v2 test request to confirm requests land in `five_hour` / `seven_day` buckets, not `extra_usage`.

**Operational gotchas surfaced by the spike (carry into P2):**

- `/srv/apps` is root-owned on this host. The P2 W2.1 `git clone .../srv/apps/nanoclaw-v2` will require a manual `sudo mkdir + chown` step before the clone can land.
- `pnpm` lives at `~/.npm-global/bin/pnpm` (v11.1.3 from the spike's substitute install). It's on `~/.bashrc`'s PATH but **not** on the Claude Code Bash tool's default PATH. Every pnpm call in P2 needs `PATH="/home/john/.npm-global/bin:$PATH"` or an absolute path.
- v2's `setup.sh` / `nanoclaw.sh` are heavily interactive and collapse under the Claude Code Bash tool's non-TTY stdin. **Run the v2 installer from a real terminal**, not from Claude Code. Same note already applies to `migrate-v2.sh` in P3.
- v2's slug-suffixed unit name for `/srv/apps/nanoclaw-v2/` resolves to `nanoclaw-9c12bd9b.service` (per `sha1(path)[:8]`). v1's unit is non-suffixed and won't collide.

---

### P2: Parallel v2 install at `/srv/apps/nanoclaw-v2/`

#### W2.1: Clone upstream/main fresh

**Action:**

```bash
git clone https://github.com/nanocoai/nanoclaw.git /srv/apps/nanoclaw-v2
cd /srv/apps/nanoclaw-v2
git log --oneline -5
```

**Verification:**

```bash
ls /srv/apps/nanoclaw-v2/setup.sh /srv/apps/nanoclaw-v2/migrate-v2.sh
git -C /srv/apps/nanoclaw-v2 log --oneline -1
# v2.0.64 or later
```

**Rollback:** `rm -rf /srv/apps/nanoclaw-v2`.

---

#### W2.2: Install prerequisites

**Action:**

```bash
# Check Node version against v2's .nvmrc:
cat /srv/apps/nanoclaw-v2/.nvmrc 2>&1
node --version  # must match or exceed .nvmrc
# Install pnpm if missing:
command -v pnpm || npm install -g pnpm
# Install Bun if v2 requires it (check container/Dockerfile or package.json):
grep -l bun /srv/apps/nanoclaw-v2/container/Dockerfile /srv/apps/nanoclaw-v2/package.json 2>&1
# If matched, install Bun: curl -fsSL https://bun.sh/install | bash
```

**Verification:**

```bash
pnpm --version
node --version
# Both produce output
```

**Rollback:** n/a (installing tools is non-destructive).

---

#### W2.3: Run base v2 install

**Action:**

```bash
cd /srv/apps/nanoclaw-v2
[ -f nanoclaw.sh ] && BOOT=./nanoclaw.sh || BOOT=./setup.sh
bash "$BOOT"
# Choose minimal options. DO NOT register real production channels yet — that's W3.3.
# DO NOT enable the systemd unit yet — we wait until W7.6.
```

**Verification:**

```bash
ls /srv/apps/nanoclaw-v2/.env
ls /srv/apps/nanoclaw-v2/node_modules | head -3
systemctl --user list-unit-files | grep nanoclaw
# Should show ONLY v1's nanoclaw.service. If a v2 unit was auto-enabled, disable it now.
```

**Rollback:**

```bash
rm -rf /srv/apps/nanoclaw-v2
# Disable any v2 unit that snuck in:
systemctl --user list-unit-files | grep nanoclaw- | awk '{print $1}' | \
  xargs -r -I{} sh -c 'systemctl --user disable {} || true; rm -f ~/.config/systemd/user/{}'
systemctl --user daemon-reload
```

---

#### W2.4: Register Anthropic subscription secret in OneCLI

**Action:**

The v2 installer (W2.3) walks the operator through `claude setup-token` → `onecli secrets create --type anthropic`. If that step was completed during W2.3, this work unit is a no-op verification. If it was skipped (e.g., the operator declined auth setup at install time), run it now:

```bash
# Re-use v1's existing OAuth token if still valid:
TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' /srv/apps/nanoclaw/.env | cut -d= -f2-)
PATH="/home/john/.npm-global/bin:$PATH" \
  onecli secrets create \
  --name Anthropic \
  --type anthropic \
  --value "$TOKEN" \
  --host-pattern api.anthropic.com
# Or, if the token has expired or you want a fresh one:
# claude setup-token   # captures sk-ant-oat01-... interactively, then prompts to store via OneCLI
```

**Verification:**

```bash
PATH="/home/john/.npm-global/bin:$PATH" onecli secrets list
# Expect: an entry named "Anthropic" with type=anthropic, host-pattern=api.anthropic.com
```

**Rollback:**

```bash
PATH="/home/john/.npm-global/bin:$PATH" onecli secrets delete Anthropic
```

**Notes:**

- This replaces the pre-P1 step ("merge `upstream/skill/native-credential-proxy`"), which was found dead during the P1 spike (see [spike-notes.md](spike-notes.md) §2 W1.3).
- The token is the same `sk-ant-oat01-…` secret used in production v1. Treat accordingly: do not commit; do not paste into chat.
- Until cutover (W7.x), v1's `.env` still needs `CLAUDE_CODE_OAUTH_TOKEN` set — v1's credential proxy reads it from `.env`, not from the OneCLI vault. Both can coexist on the same token.
- Wire-level verification that this preserves subscription billing happens in P6 (W6.7) before cutover.

---

#### W2.5: Set non-colliding ports

**Action:**

Post-P1, the only fork-local host port that needs shifting is health (`/health` server). The custom credential proxy is retired, so `CREDENTIAL_PROXY_PORT` is no longer relevant. Edit `/srv/apps/nanoclaw-v2/.env`:

```
HEALTH_PORT=4002
```

Also scan v2's `src/config.ts` (or `src/modules/config/`) for any other host-bound port defaults that overlap v1's listeners and shift each into the 4xxx range. OneCLI listens on its own socket/port managed by the daemon; v1 doesn't run OneCLI, so OneCLI cannot collide.

**Verification:**

```bash
grep -E '^HEALTH_PORT=' /srv/apps/nanoclaw-v2/.env
ss -tlnp 2>/dev/null | awk '$4 ~ /:(3002|4002)$/'
# Only v1's 3002 — v2 not started yet
```

**Rollback:** n/a (just re-edit `.env`).

---

#### W2.6: Build the agent container

**Action:**

```bash
cd /srv/apps/nanoclaw-v2
# Check the v2 build script:
ls container/build.sh 2>&1 || ls container/Dockerfile
# If build.sh exists:
./container/build.sh
# Else, follow whatever v2's container README specifies (likely docker build with a tag)
```

**Verification:**

```bash
docker images | grep -E "nanoclaw.*v2|agent-runner"
# Image for v2 appears with a recent CREATED timestamp
```

**Rollback:**

```bash
docker images | grep -E "nanoclaw.*v2|agent-runner" | awk '{print $3}' | xargs -r docker rmi
```

**Notes:**
v2's image build cache is aggressive (same caveat as v1). If layers look stale, `docker builder prune` and re-run.

---

#### W2.7: Confirm clean build and tests

**Action:**

```bash
cd /srv/apps/nanoclaw-v2
pnpm run build
pnpm test
```

**Verification:**

```bash
echo $?  # 0 expected after pnpm test
ls /srv/apps/nanoclaw-v2/dist 2>&1 | head -3  # or wherever v2 emits build artifacts
```

**Rollback:** n/a (build/test are read-only-side-effect except for `dist/` which is regenerable).

**Notes:**
If tests fail at this stage, that's a v2-upstream issue (not a porting issue) — STOP and investigate before P3. A red baseline makes later test failures impossible to diagnose.

---

### P3: Data migration via `migrate-v2.sh`

**Status: COMPLETE (2026-05-21).** See [p3-notes.md](p3-notes.md) for the immutable record. The work units below are kept as written for historical reference; the **only changes to apply on a re-run** are: (a) W3.5 must be SKIPPED if W3.6 has run (v2 already holds the WA Baileys keystore), and (b) W3.6 effectively performs the cutover — see [p3-notes.md](p3-notes.md) §3.1.

> ⚠️ **Warning — `/migrate-from-v1` crosses the P7 one-way door.** The skill's smoke-test phase (W3.6) starts the v2 systemd unit, exercises a real WhatsApp roundtrip, and restarts the service. By the time the skill reports `STATUS: success`, v2 is live in production for the migrated channels. This was not anticipated in the pre-P3 plan. See [p3-notes.md](p3-notes.md) §3.1.

This is where v1 data flows into v2. **Run from a real terminal, not the Claude Code Bash tool** — the script needs interactive prompts and a real TTY.

#### W3.1: Stop v1 service for consistent migration

**Action:**

```bash
systemctl --user stop nanoclaw.service
systemctl --user status nanoclaw.service | head -5  # confirm inactive
# Take a clean stopped-service backup right now:
TS=$(date -u +%Y%m%d-%H%M%S)
tar -czf ~/backups/nanoclaw-pre-migrate-v2-${TS}.tar.gz \
  -C /srv/apps/nanoclaw store data groups
```

**Verification:**

```bash
systemctl --user is-active nanoclaw.service  # "inactive"
ls -lh ~/backups/nanoclaw-pre-migrate-v2-*.tar.gz
```

**Rollback:**

```bash
systemctl --user start nanoclaw.service
```

**Notes:**
v1 is now down. Channels are unresponsive until W3.5. User is aware (see motivation doc — downtime is acceptable).

---

#### W3.2: Run `migrate-v2.sh`

**Action (in a real terminal, not Claude Code Bash):**

```bash
cd /srv/apps/nanoclaw-v2
NANOCLAW_V1_PATH=/srv/apps/nanoclaw bash migrate-v2.sh
```

**Verification:**

Script completes without non-zero exit. Watch stdout for any `ERROR` or `FAIL` lines.

```bash
echo $?  # 0
ls /srv/apps/nanoclaw-v2/logs/setup-migration/handoff.json
```

**Rollback:**

```bash
# Restore v2 to pre-migrate state by re-cloning (this is faster than reverse-engineering what migrate-v2.sh changed):
rm -rf /srv/apps/nanoclaw-v2
# Then re-run W2.1 through W2.7.
# v1 data is untouched by migrate-v2.sh — it reads from $NANOCLAW_V1_PATH, doesn't write to it.
```

**Notes:**
**Run this from your normal terminal (SSH session, tmux pane, console — not via Claude Code).** The script collapses if stdin/stdout aren't a TTY.

---

#### W3.3: Walk interactive prompts

**Action:**

During `migrate-v2.sh`:

- **Channel selection:** select WhatsApp, Slack, Gmail. Skip everything else.
- **Service switchover:** **DECLINE.** We want to do P4 (porting fork features) before any v2 service takes over. The script may phrase this as "Install systemd unit now?" or "Switch over channels now?" — answer no to both.
- **CLAUDE.local.md cleanup:** accept (handled by `/migrate-from-v1` in W3.6).
- **Container config reconciliation:** accept defaults; we'll reconcile manually in P4 if needed.

**Verification:** script reaches "migration complete" without auto-starting any v2 service.

```bash
systemctl --user list-units --state=active | grep nanoclaw
# Expect: empty (v1 is stopped from W3.1, v2 not started)
```

**Rollback:** see W3.2.

---

#### W3.4: Inspect handoff.json

**Action:**

```bash
cat /srv/apps/nanoclaw-v2/logs/setup-migration/handoff.json | jq .
# If jq not available:
python3 -m json.tool /srv/apps/nanoclaw-v2/logs/setup-migration/handoff.json
```

**Verification:**

Top-level `overall_status` must be `success` or `partial`. Walk the `steps` array — any step with `status: failed` needs to be understood and resolved before P4. Common failure modes (resolve in-place if seen):

- WA Baileys keystore copy fails → check `~/.config/nanoclaw/whatsapp-auth/` exists and is readable.
- Gmail credentials copy fails → check `~/.config/nanoclaw/gmail-credentials.json` exists.
- DB schema apply fails → check `pnpm test` was green in W2.7.

**Rollback:**

If a step is recoverable, fix it and rerun `migrate-v2.sh` (the script should be idempotent — verify by re-reading it before re-running). If not recoverable, see W3.2 rollback.

---

#### W3.5: Restart v1 service so the user has a working bot during porting

> 🛑 **SKIP THIS WORK UNIT if W3.6 (`/migrate-from-v1`) has run.** v2 holds the WhatsApp Baileys keystore after W3.6's smoke test. Restarting v1 from this point creates a concurrent Baileys session and breaks WA on both. See [p3-notes.md](p3-notes.md) §3.1. v1 stays stopped + disabled; operator uses v2 (which is now live) for the duration of P4.

**Action (if W3.6 has not yet run — uncommon):**

```bash
systemctl --user start nanoclaw.service
sleep 5
systemctl --user is-active nanoclaw.service
```

**Verification:**

```bash
journalctl --user -u nanoclaw.service -n 30 --no-pager
# Look for "READY" or equivalent startup log
# Then send a quick test message in a real channel to confirm bot responds
```

**Rollback:**

```bash
systemctl --user stop nanoclaw.service
```

**Notes:**
In the original plan v1 was supposed to serve production during P4 porting (against a stopped v2). In practice, W3.6 starts v2 and crosses the cutover; v1 stays down from W3.1 onward.

---

#### W3.6: Run upstream's `/migrate-from-v1` skill

> ⚠️ **This skill effectively performs the P7 cutover.** Its smoke-test phase starts the v2 systemd unit, exercises a real channel roundtrip, and restarts the service. By the time it reports `STATUS: success`, v2 is live and v1 cannot be restarted on the same channels. See [p3-notes.md](p3-notes.md) §3.1.

**Action:**

In `claude` opened against `/srv/apps/nanoclaw-v2`:

```
/migrate-from-v1
```

Follow its 6 phases. It handles:

- Owner seeding (creates a `users` row + grants the global `owner` role to the operator's primary channel identity)
- `CLAUDE.local.md` cleanup across all migrated groups (strips v1 boilerplate, repoints v1-specific paths)
- Container config reconciliation — `additional_mounts` in `container_configs` are walked, v1-specific paths repointed where applicable, the mount allowlist extended to cover `/srv/apps/nanoclaw-v2`
- Channel adapter installation files (`src/channels/{whatsapp,slack,resend}.ts`) appear in the v2 working tree as untracked — they're upstream skill output, not changes to commit locally unless desired
- **Smoke test phase: starts the v2 systemd unit, attempts a real inbound roundtrip on each migrated channel.** If the smoke test passes, the skill restarts the service to apply final changes. v2 is now production.

**Verification:**

```bash
systemctl --user is-active nanoclaw-v2-787facac.service   # active
systemctl --user is-enabled nanoclaw-v2-787facac.service  # enabled
PATH="/srv/apps/nanoclaw-v2/bin:$PATH" ncl groups list --json | jq '.data | length'  # matches v1 registered_groups count
PATH="/home/john/.npm-global/bin:$PATH" onecli secrets list | grep -i Anthropic   # subscription token in vault
```

Send a real message in each migrated channel and confirm a reply arrives. **Slack inbound will likely fail** — that's not a `/migrate-from-v1` bug; see [p3-notes.md](p3-notes.md) §3.2 (v2's Slack adapter is webhook-only, v1's was Socket Mode).

**Rollback:**

This is now a P7-equivalent step. Rollback after a successful W3.6 means reversing the cutover — see §7 master rollback "After P7" branch. In practice: stop+disable v2's unit, restart v1's unit, re-pair WhatsApp on v1 (the Baileys keystore now lives in v2's data dir).

---

### P4: Port fork-local features onto v2

Most labor-intensive phase. The fork's custom credential proxy is **retired**, not ported (P1 outcome — see [spike-notes.md](spike-notes.md) §3); subscription auth was wired in at W2.4 via OneCLI's Anthropic-typed secret.

> **Post-W4.5 ordering** (see [p3-notes.md](p3-notes.md) §9 + §10 + §11): P4 runs against a LIVE v2 in production. **W4.0 (Slack inbound), W4.3 (health/watchdog), and W4.5 (`/usage`) are DONE** — see below. **W4.1 (sender allowlist) is optional / likely retire** — v1 never enforced it in production (see [p3-notes.md](p3-notes.md) §3.6). Remaining order: **W4.4 → W4.5.1 → W4.7 → W4.6**, plus follow-ups: **W4.8 (Slack interactivity port)**, **W4.9 (chat-sdk-bridge consumer audit)**, and **v2 installer-template watchdog patch** (from W4.3).

All work in `/srv/apps/nanoclaw-v2`. Read v1 implementation in `/srv/apps/nanoclaw/src/<file>.ts` before porting.

#### W4.0: Restore Slack inbound — DONE 2026-05-22

**Outcome:** ✅ Slack inbound restored end-to-end via Path A (Tailscale Funnel + Events API reconfig on the existing Slack app). Bot identity `U0AMHR1U9L0` + all 9 channel memberships preserved. Public URL: `https://agent.flicker-enigmatic.ts.net/webhook/slack`.

Authoritative records:
- [slack-inbound-decision.md](slack-inbound-decision.md) — path choice (A vs B vs C), parity audit showing A and C are feature-identical, click-by-click Slack-app reconfig steps.
- [p3-notes.md](p3-notes.md) §9 — resolution log, ops gotchas, and follow-ups discovered.

**Key surprise to carry forward:** Tailscale Funnel needs an explicit `sudo tailscale cert <domain>` step even after HTTPS Certificates is enabled at the tailnet level and `tailscale funnel --bg 3000` succeeds. Without it, the public DNS auth NS (DNSimple) returns NXDOMAIN. Diagnosis cost: ~15 minutes. Future Funnel setup: treat `tailscale cert` as a required step, not auto-magical. Also note: `tailscale cert` writes cert + key files to CWD as a side effect; clean them up after.

**Rollback** (if needed): re-enable Socket Mode in the Slack app dashboard; disable Event Subscriptions. `tailscale funnel reset` to remove public ingress. v2 code unchanged this work unit, so no code rollback.

---

#### W4.8: Slack interactivity / block_actions handler port (NEW, surfaced by W4.0)

**Context:** v1's `src/channels/slack.ts` registers two `app.action()` regex handlers for the git-maintenance branch-delete flow:
- `app.action(/^nanoclaw_checkbox_/, …)` — ack checkbox toggles
- `app.action(/^nanoclaw_confirm_/, …)` — extract selected branches and deliver a synthetic inbound message to the agent

v2's `@chat-adapter/slack` does parse interactivity payloads at `/webhook/slack` (the form-encoded `payload` field), but it's unverified whether v2's `chat-sdk-bridge.ts` surfaces those events to channel consumers. The next Mon/Thu 02:03 CEST git-maintenance cron will post a checkbox message that cannot be confirmed via Slack until this is ported.

**Action:**

1. Read `/srv/apps/nanoclaw/src/channels/slack.ts` lines 140–220 (action handlers).
2. Read v2's `/srv/apps/nanoclaw-v2/src/channels/chat-sdk-bridge.ts` and `chat-sdk-bridge.test.ts` — look for any `onAction` / `onBlockAction` / `payload_type` / `block_actions` surface.
3. If v2 exposes an action-handler hook on the channel-registry contract → wire v1's regex handlers onto it.
4. If v2 does NOT expose one → file an upstream issue OR write a thin wrapper that intercepts the raw webhook payload before passing to `@chat-adapter/slack` for action types.
5. Tests: write a test that POSTs a signed `block_actions` payload to `/webhook/slack` and verifies the synthetic inbound message lands.

**Verification:**

Trigger the git-maintenance cron manually (or wait for Mon/Thu) — operator clicks the confirm checkbox — confirm the agent receives the synthetic inbound and deletes the selected branches.

**Rollback:** `git checkout --` the bridge changes (if any) on v2's working tree.

---

#### W4.9: chat-sdk-bridge consumer audit (NEW, surfaced by W4.0)

**Context:** v2's `@chat-adapter/slack` exposes (per its `.d.ts`):
- File metadata inbound (`SlackEvent.files[]` with mimetype, url_private, dimensions, size)
- Reaction inbound (`SlackReactionEvent` for `reaction_added`/`reaction_removed`)
- Native typing indicator (`startTyping(threadId, status?)`, needs `assistant:write` scope)
- Streaming output (`stream(threadId, textStream, options)`)
- File upload outbound (`AdapterPostableMessage` + private `uploadFiles`)

v2's consumer-side bridge (`src/channels/chat-sdk-bridge.ts`, 28k file) is the layer that decides what's actually piped through to the agent. v1 had: image inbound (multimodal), voice inbound (Whisper), PDF inbound (text reference), `:eyes:` emoji reactions for status-tracker, no streaming, no inbound reaction handling. **Unverified whether v2's bridge wires any/all of these to the agent's prompt.**

**Action:**

1. For each capability above, grep `chat-sdk-bridge.ts` for whether it reads/writes the surface.
2. Write a comparison matrix: v1 behavior | v2-adapter capability | v2-bridge wired? | gap to close.
3. Decide which gaps to close in this work unit vs. defer (e.g., streaming is a bonus, not a v1 parity item).
4. Implement closures; write tests.

**Verification:** Send each input type (image, voice note, PDF, reaction) in Slack and confirm the agent sees it the way v1 saw it.

**Rollback:** Per-feature `git checkout --` on bridge changes.

---



#### W4.1: Sender allowlist

**Action:**

1. Read `/srv/apps/nanoclaw/src/sender-allowlist.ts` and its test file.
2. Read v2's `src/modules/permissions/` (every file).
3. Decide:
   - **(a) Port atop v2's permissions module** as defence-in-depth — keep v1's per-chat allowlist semantics, layer on top of v2's `unknown_sender_policy` / `agent_group_members`.
   - **(b) Translate into v2's permission model** — re-express v1's allowlist rules using v2's primitives, drop our code.
4. Implement chosen approach.
5. Write/port tests.

**Verification:**

```bash
cd /srv/apps/nanoclaw-v2
pnpm test -- --filter sender-allowlist  # or whatever the test invocation is
# All tests pass
```

Send a real message from an allowlisted sender (expect: agent responds) and from a non-allowlisted sender (expect: silently dropped or rejected per the policy).

**Rollback:**

```bash
cd /srv/apps/nanoclaw-v2
git diff src/modules/permissions  # review
git checkout -- src/modules/permissions  # if porting needs reverting
```

**Notes:**
Defence-in-depth (option a) is the safer default. Only choose (b) if v2's permissions model genuinely covers every v1 rule including the per-chat semantics.

---

#### W4.2: Status tracker

**Action:**

1. Read `/srv/apps/nanoclaw/src/status-tracker.ts`.
2. Read v2's `src/modules/typing/`.
3. Almost certainly retirable — v2's typing module covers progressive reactions for non-native channels. Confirm by reading v2's module.
4. If v2's coverage matches v1's behavior (StatusTracker progress reactions on main-group messages for non-native-typing channels), retire v1's. If not, port the missing semantics.

**Verification:**

In a non-native-typing channel (e.g., Discord if you have it; otherwise simulate via test), send a message and confirm progress feedback (reactions or equivalent) renders.

```bash
cd /srv/apps/nanoclaw-v2
pnpm test -- --filter typing
```

**Rollback:** `git checkout --` the modified files.

---

#### W4.3: Health endpoints + watchdog

**Action:**

1. Read `/srv/apps/nanoclaw/src/health.ts`, `health-server.ts`, `watchdog.ts`.
2. Confirm v2 has no equivalent (grep v2 for `WATCHDOG=1`, `sd_notify`, `/health`).
3. Re-port the three files into v2. v2's host is split across `host-sweep.ts` / `host-core.ts` / `session-manager.ts` — health collection now reads from these instead of v1's monolithic `index.ts` state.
4. Update v2's systemd unit template (find via `grep -r "Type=" setup/`) to include `Type=notify`, `NotifyAccess=all`, `WatchdogSec=30s`.
5. Write/port tests.

**Verification:**

```bash
cd /srv/apps/nanoclaw-v2
pnpm test -- --filter health
# Tests pass
# Run dev mode briefly:
pnpm run dev &
DEV_PID=$!
sleep 5
curl -sS http://127.0.0.1:4002/health | jq .
# Returns JSON with healthy/degraded status
kill $DEV_PID
```

**Rollback:** `git checkout --` modified files.

**Notes:**
The known installer gap from v1 (Type=simple in fresh-install unit files) is the chance to fix in v2 — bake the watchdog flags into v2's installer template directly.

---

#### W4.4: Mount security

**Action:**

1. Read `/srv/apps/nanoclaw/src/mount-security.ts` and its test.
2. Read v2's `src/modules/mount-security/`.
3. Verify v2's covers all of: realpath resolution, blocked-pattern list (credential dotfiles), colon-injection guard on container paths, `nonMainReadOnly` flag, fail-closed on missing allowlist file.
4. If v2's covers all → retire ours, confirm `~/.config/nanoclaw/mount-allowlist.json` format is compatible (or migrate it).
5. If gaps → port the missing parts onto v2's module.

**Verification:**

```bash
cd /srv/apps/nanoclaw-v2
pnpm test -- --filter mount-security
# All cases pass: blocked patterns, colon injection, missing allowlist
```

**Rollback:** `git checkout --` modified files.

**Notes:**
This is a security boundary. Do not skip the test pass. If in doubt, keep our `mount-security.ts` as a redundant check.

---

#### W4.5: Host commands — `/usage` (DONE 2026-05-22)

**Outcome:** ✅ `/usage` works on both surfaces — `ncl usage` (CLI top-level command) and chat `/usage` (admin-gated, handled inline by command-gate's new `respond` action). Token sourced from `~/.claude/.credentials.json` (NOT OneCLI vault — see [p3-notes.md](p3-notes.md) §11 for why OneCLI option was rejected). Test suite green: 36 files / 389 tests (+32). Files added: `src/usage.ts` + `src/usage.test.ts` + `src/cli/commands/usage.ts` + `src/command-gate.test.ts`. Files modified: `src/cli/commands/index.ts` (import), `src/command-gate.ts` (new `respond` action + `HOST_RESPONDER_COMMANDS` map), `src/router.ts` (handle `respond` action).

Authoritative record: [p3-notes.md](p3-notes.md) §11.

**Key surprise:** OneCLI cannot serve `/api/oauth/usage`. The `@onecli-sh/sdk` exposes no `getSecret(name) -> value` method, and the OneCLI gateway on `127.0.0.1:10255` injects `x-api-key`-style auth (the `/v1/messages` SDK contract), not the `Authorization: Bearer sk-ant-oat01-...` + `anthropic-beta: oauth-2025-04-20` pair the OAuth usage endpoint needs. Fallback to v1's `~/.claude/.credentials.json` reader is the only viable path. See [p3-notes.md](p3-notes.md) §11 for the full chain of evidence.

**Rollback** (if needed): `git checkout --` the seven files listed above; `pnpm run build`; `systemctl --user restart nanoclaw-v2-787facac.service`. v2 reverts to the curl-from-host baseline of [p3-notes.md](p3-notes.md) §3.3.

---

#### W4.5.1: `/status` chat command (NEW, fold-in from W4.5)

**Action:**

`/status` overlaps with the v2 `/health` endpoint W4.3 added; v1's chat `/status` rendered the same snapshot. Cheap port now that the `respond` GateResult shape exists:

1. Export a `formatHealthText(snapshot)` helper from `src/health.ts` if not already exposed.
2. Add a `snapshotHealth` getter that the `respond` renderer can call (the wired-up snapshot composer already lives in `src/index.ts` for W4.3's `/health` server — refactor or expose it for direct host use).
3. Add `'/status': () => formatHealthText(snapshotHealth())` to `HOST_RESPONDER_COMMANDS` in `src/command-gate.ts`.
4. One test in `src/command-gate.test.ts` for the new entry.

**Verification:** send `/status` in Slack as an admin user; receive a formatted health snapshot identical to `curl http://127.0.0.1:3002/health` shape, but human-readable.

**Rollback:** `git checkout --` the touched files.

**Estimate:** <30 min once W4.4 settles, or fold into W4.4's commit if convenient.

---

#### W4.6: Remote-control

**Action:**

1. Read `/srv/apps/nanoclaw/src/remote-control.ts` and `data/remote-control.json` shape.
2. Investigate v2's session model — does it support an ad-hoc `claude.ai/code` handover?
3. If portable → port; if not cleanly portable → document the incompatibility in `docs/v2-migration/deferred-items.md` and skip for v0 of the migration. This is not a blocker for cutover.

**Verification:**

If ported: trigger remote-control via the documented flow (likely a slash command) and confirm a `claude.ai/code` URL is generated.

If skipped: confirm `docs/v2-migration/deferred-items.md` documents the gap and a workaround.

**Rollback:** `git checkout --` modified files; if deferred, just don't commit anything.

**Notes:**
This is a "nice-to-have" fork feature, not load-bearing. Don't burn the migration on it.

---

#### W4.7: Journal MCP integration

**Action:**

1. Read v1's conditional registration in `/srv/apps/nanoclaw/container/agent-runner/src/index.ts` (grep for `JOURNAL_MCP_URL` and `JOURNAL_API_TOKEN`).
2. Read v2's container runtime (Bun-based — check `/srv/apps/nanoclaw-v2/container/`).
3. Port the conditional registration: if `JOURNAL_MCP_URL` is set and `JOURNAL_API_TOKEN` is set, register the MCP server at startup.
4. Fix any `bun:sqlite` parameter syntax issues (uses `$name` instead of `?` or `@name` — relevant if any DB code touches journal data).
5. Ensure `JOURNAL_MCP_URL` and `JOURNAL_API_TOKEN` are passed into the container env (check v2's `container-runner` equivalent).

**Verification:**

In v2 dev mode, spawn a container with `JOURNAL_MCP_URL` and `JOURNAL_API_TOKEN` set. Inside the container (or via SDK message), confirm `mcp__journal__*` tools are listed. Call `mcp__journal__journal_list_entries` with a small limit; expect a successful response.

```bash
# From a v2 dev session, send a chat message that lists tools, then call a journal tool.
# Or: from the container, `claude` REPL with --list-tools to see journal__*.
```

**Rollback:** `git checkout --` modified files.

**Notes:**
The journal MCP server lives at `192.168.2.105:8400` (per project memory). It must be reachable from the container's network namespace.

---

### P5: Channel re-installation in v2

Channels were registered by `migrate-v2.sh` (W3.3). This phase re-applies our fork's per-channel customizations onto v2's adapter shape.

#### W5.1: Slack

**Action:**

1. Read `/srv/apps/nanoclaw/src/channels/slack.ts` and `/srv/apps/nanoclaw/docs/slack-attachments.md`.
2. Read v2's Slack adapter (likely at `/srv/apps/nanoclaw-v2/src/channels/slack.ts` or `/srv/apps/nanoclaw-v2/.claude/skills/add-slack/`).
3. Re-apply fork customizations onto v2's adapter:
   - `thread_ts` capture
   - Migration v6 (`thread_ts` column in messages table) — check that v2's schema either already has this or that we apply the migration to v2's DB
   - `send_blocks` MCP tool with `thread_id` parameter
   - `getThreadMessages()` helper
   - Anything in our slack.ts that differs from upstream (use `git diff upstream/main..main -- src/channels/slack.ts` from v1 dir as the reference diff)
4. Write/port tests.

**Verification:**

```bash
cd /srv/apps/nanoclaw-v2
pnpm test -- --filter slack
# Tests pass
```

In dev mode, send a threaded message in a real Slack test channel; confirm the bot's reply lands in the same thread.

**Rollback:** `git checkout --` modified files.

---

#### W5.2: WhatsApp

**Action:**

1. Verify Baileys keystore migrated cleanly (look for `auth_info_baileys/` or equivalent in v2's WA channel data dir).
2. Confirm `ASSISTANT_HAS_OWN_NUMBER=true` semantics survive — check v2's `src/channels/whatsapp.ts` for the `fromMe` flag handling.
3. In v2 dev mode (with v1 stopped briefly to release the Baileys session, OR using a fresh-paired throwaway WA Business number for testing), send a test message to the WA test chat.

**Verification:**

Test message round-trips. No re-pairing prompt.

**Rollback:**

If WA pairing breaks, refer to `runbooks/re-auth.md` and re-pair. v1's keystore is still intact in `/srv/apps/nanoclaw/` if we need to fall back.

**Notes:**
WA Baileys does NOT support concurrent sessions with the same keystore. To test v2 without breaking v1, either (a) test from the throwaway spike-style number, or (b) stop v1 temporarily and re-start after the test.

---

#### W5.3: Gmail

**Action:**

1. Verify `gmail-autoauth-mcp` credentials survived migration (look for `~/.config/nanoclaw/gmail-credentials.json` or v2's new path).
2. Confirm v2's Gmail channel adapter is in place.
3. Send a test email to the configured Gmail address.

**Verification:**

Email received by Gmail channel, agent responds.

**Rollback:**

If Gmail auth broken, follow `runbooks/re-auth.md` (Gmail section).

---

### P6: Pre-cutover smoke testing

#### W6.1: Full test suite

**Action:**

```bash
cd /srv/apps/nanoclaw-v2
pnpm test
```

**Verification:** exit 0, no failures.

**Rollback:** n/a.

**Notes:** If any test fails here, do NOT proceed to cutover. Fix or document and reassess.

---

#### W6.2: Clean build

**Action:**

```bash
cd /srv/apps/nanoclaw-v2
pnpm run build
```

**Verification:** exit 0, build artifacts in `dist/` (or wherever).

**Rollback:** n/a.

---

#### W6.3: Run v2 smoke test

**Action:**

```bash
cd /srv/apps/nanoclaw-v2
# Check for v2's smoke test script:
ls scripts/smoke-test.ts 2>&1
# If exists:
npx tsx scripts/smoke-test.ts
# Or v2 may have its own variant — check setup.sh or README for the canonical invocation
```

**Verification:** exit 0.

**Rollback:** n/a.

---

#### W6.4: Manual end-to-end walk

**Action:**

With v1 still running (production traffic untouched):

1. Start v2 in dev mode against a separate test group: `cd /srv/apps/nanoclaw-v2 && pnpm run dev`
2. From Slack test channel (NOT a production channel), send a message that triggers the agent.
3. Confirm container spawns, agent responds, scheduled task can be created (`schedule_task` MCP tool), task is retrievable via DB query.
4. Wait for the scheduled task to fire (or set it to fire in 1 minute); confirm it executes.

**Verification:**

```bash
# Inspect v2's DB:
node -e "
const Database = require('better-sqlite3');
const db = new Database('/srv/apps/nanoclaw-v2/data/v2.db', {readonly: true});
console.log(db.prepare('SELECT id, status FROM tasks ORDER BY id DESC LIMIT 5').all());
"
# DB path may differ in v2 — check src/modules/storage/ or similar for the canonical path
```

**Rollback:** Ctrl-C the dev process.

**Notes:**
DB path is v2-specific — confirm the actual path from v2's storage module before running the query. v1's path (`store/messages.db`) likely changed.

---

#### W6.5: Confirm CLAUDE.local.md cleanup

**Action:**

```bash
cat /srv/apps/nanoclaw-v2/groups/main/CLAUDE.local.md 2>&1
# Should be either absent or contain only v2-appropriate content (no stale v1 boilerplate per /migrate-from-v1 Phase 2)
```

**Verification:** no v1-specific paths (`/srv/apps/nanoclaw/`, `store/messages.db`, `nanoclaw.service`) appear.

**Rollback:** edit the file by hand.

---

#### W6.6: Confirm Journal MCP tools work end-to-end in a v2 container

**Action:**

In a v2 dev-mode chat session, ask the agent to list journal entries from the last week and report what it finds. The agent should call `mcp__journal__journal_list_entries` or similar and return real data.

**Verification:** agent response includes actual journal entry data (not "tool not available" or empty).

**Rollback:** n/a (read-only test).

---

#### W6.7: Wire-verify subscription billing on v2

**Purpose:** retire the residual uncertainty from P1's static-analysis conclusion (see [spike-notes.md](spike-notes.md) §3) — confirm a real v2 container request bills against the Claude Max subscription rate-limit window, NOT against `extra_usage`. This is the last gate before the one-way-door cutover in P7.

**Action:**

1. With v2 in dev mode (continuation of W6.4), send 2–3 small test messages from a non-production test channel to force the v2 container to emit real outbound requests to `api.anthropic.com`.
2. Hit Anthropic's OAuth usage endpoint with the same `sk-ant-oat01-…` token v2 is using. Easiest reuse: port v1's `/usage` host-command handler if W4.5 has it ready; otherwise call the endpoint by hand:

   ```bash
   # Extract the access token v2 is using (OneCLI stores it; the OAuth refresh flow
   # is the same as v1's). If unsure, refresh via `claude setup-token`.
   ACCESS_TOKEN=$(jq -r .accessToken ~/.claude/.credentials.json)
   curl -sS \
     -H "Authorization: Bearer $ACCESS_TOKEN" \
     -H "anthropic-beta: oauth-2025-04-20" \
     https://api.anthropic.com/api/oauth/usage \
     | jq .
   ```

3. Inspect the response. Expected shape (per v1's [`docs/credential-proxy.md`](../credential-proxy.md) §4.3 documentation of the subscription contract):

   - `five_hour` / `seven_day` (and on Opus, `seven_day_opus` / `seven_day_sonnet`) buckets show **non-zero utilization** that increased by at least one request after step 1.
   - `extra_usage` (if present in the response shape) shows **zero or unchanged**.

**Verification:**

The five_hour / seven_day counter advanced by ≥1 between a pre-test and post-test fetch, AND no `extra_usage` increase occurred. Both must hold.

**Alternative (if `/usage` endpoint is unreachable or returns an unexpected shape):** capture an outbound request from the v2 container to `api.anthropic.com` with `mitmproxy` or `tcpdump` and confirm the request carries `Authorization: Bearer sk-ant-oat01-…` plus `anthropic-beta: oauth-2025-04-20`. Both headers must be present and unmolested. This is the cheaper-to-implement check; only fall back to it if the `/usage` lookup is blocked.

**Rollback:** n/a (read-only verification). If the check fails, STOP and do not proceed to P7 — investigate before deciding next steps. A failed check means OneCLI's MITM is doing something that breaks subscription routing; reassessing options at that point may include re-implementing the v1 credential proxy on v2's host shape using the ingredient list in [spike-notes.md](spike-notes.md) §4.

**Notes:**

- This step exists because the P1 spike never physically observed an end-to-end request through v2's OneCLI. The static-analysis conclusion (token prefix + exchange endpoint + `anthropic-beta` header all pass through unchanged) is strong but not certain. A 5-minute curl is cheap insurance before crossing the one-way door.
- If W4.5 already ported v1's `/usage` slash command to v2, prefer using it in-chat over the raw curl — it's the same endpoint, with the OAuth refresh logic already wired.

---

### P7: Cutover

**ONE-WAY DOOR.** After W7.6 starts, messages received on v2 do not replay to v1. Confirm P6 is green before starting.

> **Post-P3 update:** the cutover effectively happened during P3 W3.6 via `/migrate-from-v1`'s smoke-test phase (see [p3-notes.md](p3-notes.md) §3.1). The work units below describe the *intended* cutover sequence; **what actually applies now** is:
> - **W7.1 (final v1 backup):** still relevant — take if not already done.
> - **W7.2, W7.3 (stop + disable v1):** already happened in W3.1 + the post-W3.6 state.
> - **W7.4 (restore v2 ports to production defaults):** still relevant — v2's `HEALTH_PORT=4002` from W2.5 should move back to `3002` once v1 is permanently retired. **Defer to when W4.3 (health endpoint port) lands** — there's no health endpoint on v2 today.
> - **W7.5 (determine slug + install unit):** already happened. Slug is `787facac`. Unit at `~/.config/systemd/user/nanoclaw-v2-787facac.service`.
> - **W7.6 (enable + start v2 service):** already happened. `active+enabled`.
> - **W7.7 (tail logs to confirm clean boot):** already verified — no errors, `NRestarts=0` since the last restart.
> - **W7.8 (send "hello" in each channel):** WhatsApp ✅ verified. Slack ❌ broken pending W4.0. Gmail (as channel) not migrated. Re-run W7.8 once W4.0 lands.
> - **W7.9 (trigger a production scheduled task):** **partial credit** — scheduled tasks are migrated and the scheduler should fire them; first fire is the 07:28 CEST morning-report cron after P3. Treat as observation, not test, unless willing to manipulate the schedule.

#### W7.1: Final v1 backup

**Action:**

```bash
TS=$(date -u +%Y%m%d-%H%M%S)
tar -czf ~/backups/nanoclaw-cutover-v1-${TS}.tar.gz \
  -C /srv/apps/nanoclaw store data groups \
  -C "$HOME/.config" nanoclaw
ls -lh ~/backups/nanoclaw-cutover-v1-*.tar.gz
```

**Verification:** tarball exists, size matches expectation.

**Rollback:** n/a (additive).

---

#### W7.2: Stop v1 service

**Action:**

```bash
systemctl --user stop nanoclaw.service
systemctl --user is-active nanoclaw.service  # "inactive"
```

**Verification:**

```bash
ps -ef | grep -E "nanoclaw|node.*index" | grep -v grep
# No v1 processes
```

**Rollback:** `systemctl --user start nanoclaw.service`.

---

#### W7.3: Disable v1 from auto-start

**Action:**

```bash
systemctl --user disable nanoclaw.service
```

**Verification:**

```bash
systemctl --user is-enabled nanoclaw.service  # "disabled"
```

**Rollback:** `systemctl --user enable nanoclaw.service`.

**Notes:** unit file stays in place so we can re-enable in an emergency.

---

#### W7.4: Restore v2's ports to production defaults

**Action:**

Edit `/srv/apps/nanoclaw-v2/.env`:

```
HEALTH_PORT=3002
```

Revert any other 4xxx port shifts from W2.5. The custom credential proxy is retired (P1 outcome), so `CREDENTIAL_PROXY_PORT` is no longer in the env.

**Verification:**

```bash
grep -E '^HEALTH_PORT=' /srv/apps/nanoclaw-v2/.env
# 3002
ss -tlnp 2>/dev/null | awk '$4 ~ /:3002$/'
# Nothing yet — v1 stopped, v2 not started
```

**Rollback:** edit `.env` back to 4002.

---

#### W7.5: Determine v2's systemd unit name and install the unit

**Action:**

```bash
cd /srv/apps/nanoclaw-v2
. setup/lib/install-slug.sh && UNIT=$(systemd_unit) && echo "Unit name: $UNIT"
# Save it for the next steps:
echo "$UNIT" > /tmp/v2-unit-name
```

Then install the unit file. v2's setup script likely emits it during install — check:

```bash
ls ~/.config/systemd/user/nanoclaw-*.service 2>&1
# If absent, find v2's unit template:
find /srv/apps/nanoclaw-v2/setup -name '*.service*'
# Install by hand if needed: cp template, substitute the slug, place at ~/.config/systemd/user/
systemctl --user daemon-reload
```

**Verification:**

```bash
UNIT=$(cat /tmp/v2-unit-name)
systemctl --user cat "$UNIT" | head -20
# Unit file content visible, includes Type=notify, NotifyAccess=all, WatchdogSec=30s (per W4.3)
```

**Rollback:**

```bash
UNIT=$(cat /tmp/v2-unit-name)
rm -f ~/.config/systemd/user/${UNIT}
systemctl --user daemon-reload
```

---

#### W7.6: Enable and start v2 service

**Action:**

```bash
UNIT=$(cat /tmp/v2-unit-name)
systemctl --user enable "$UNIT"
systemctl --user start "$UNIT"
```

**Verification:**

```bash
UNIT=$(cat /tmp/v2-unit-name)
systemctl --user is-active "$UNIT"  # "active"
systemctl --user is-enabled "$UNIT"  # "enabled"
```

**Rollback:**

```bash
UNIT=$(cat /tmp/v2-unit-name)
systemctl --user stop "$UNIT"
systemctl --user disable "$UNIT"
# Then bring v1 back:
systemctl --user enable nanoclaw.service
systemctl --user start nanoclaw.service
```

**Notes:** **This is the one-way door.** Inbound messages from this point land on v2.

---

#### W7.7: Tail logs to confirm clean boot

**Action:**

```bash
UNIT=$(cat /tmp/v2-unit-name)
journalctl --user -u "$UNIT" -f
# Watch for READY=1, all channels registered, no ERROR lines
# Ctrl-C after 30 seconds of clean log output
```

**Verification:**

```bash
UNIT=$(cat /tmp/v2-unit-name)
journalctl --user -u "$UNIT" -n 100 --no-pager | grep -iE "error|fatal"
# Empty
curl -sS http://127.0.0.1:3002/health | jq .
# Returns healthy status
```

**Rollback:** see W7.6 rollback.

---

#### W7.8: Send a real "hello" in each production channel

**Action:**

From each of WhatsApp, Slack, Gmail, send a "hello" message that triggers the agent.

**Verification:**

Agent responds in each within ~30s. If any channel is silent → STOP, investigate, consider rollback.

**Rollback:** see W7.6 rollback.

---

#### W7.9: Trigger a production scheduled task

**Action:**

Ask the agent (in any production channel) to schedule a task for 2 minutes from now (e.g., "schedule a task in 2 minutes that replies 'cutover-test ok'").

**Verification:**

Task fires at the scheduled time. Reply lands in chat.

```bash
UNIT=$(cat /tmp/v2-unit-name)
journalctl --user -u "$UNIT" -n 50 --no-pager | grep -i "scheduled"
# Look for task firing log
```

**Rollback:** see W7.6 rollback.

---

### P8: Post-cutover hardening

#### W8.1: Update auto-memory and project memories

**Action:**

Edit `~/.claude/projects/-srv-apps-nanoclaw/memory/MEMORY.md` and any referenced memory files. Update paths:

- `store/messages.db` → v2's DB path (resolve from v2's storage module)
- `nanoclaw.service` → v2's unit name (from W7.5)
- Any other v1-specific paths surfaced by `grep -r "/srv/apps/nanoclaw/store" ~/.claude/projects/-srv-apps-nanoclaw/memory/`

**Verification:**

```bash
grep -rE "store/messages.db|nanoclaw\.service" ~/.claude/projects/-srv-apps-nanoclaw/memory/
# Empty
```

**Rollback:** restore from `git` (if memory dir is git-tracked) or by hand from a copy.

---

#### W8.2: Rewrite project CLAUDE.md

**Action:**

Decide: keep `/srv/apps/nanoclaw-v2/` as the new home (CLAUDE.md lives there), or rename so the production install lives at `/srv/apps/nanoclaw/` (see W8.5).

Either way, the CLAUDE.md needs to describe v2's file structure: modular `src/modules/*` layout, v2's slug-suffixed systemd unit, pnpm/Bun toolchain, v2's DB path, channels-as-skill model.

Use v1's current CLAUDE.md as a template; gut the parts that no longer apply.

**Verification:**

Read the new CLAUDE.md end-to-end. Open `claude` against the project; confirm the file loads as project instructions and the "Where to look first" table points to real files.

**Rollback:** `git checkout --` the file.

---

#### W8.3: Update runbooks

**Action:**

For each of:

- `runbooks/troubleshooting.md`
- `runbooks/re-auth.md`
- `runbooks/service-management.md`
- `runbooks/database-operations.md`

Update commands and paths for v2 (unit name, DB path, log paths, channel re-auth steps where v2's channel adapter differs from v1's).

**Verification:**

`grep -rE "store/messages.db|nanoclaw\.service" runbooks/`

Empty.

**Rollback:** `git checkout --` modified files.

---

#### W8.4: Update CI workflow

**Action:**

Edit `.github/workflows/ci.yml`:

- `npm` → `pnpm` (or whatever v2 uses)
- Update test invocation to match v2's layout
- Reconsider the schema-version / skill-rebase guards: are they still meaningful on v2? If yes, keep; if not, remove.

**Verification:**

Push to a feature branch; CI runs green.

**Rollback:** `git checkout --` `.github/workflows/ci.yml`.

---

#### W8.5: Decide on final repo layout

**Action:**

Pick one:

- **Option A:** keep `/srv/apps/nanoclaw-v2/` as the new home. Rename `/srv/apps/nanoclaw/` → `/srv/apps/nanoclaw-pre-v2/`.
- **Option B:** rename so the production install lives at `/srv/apps/nanoclaw/` again. Move `/srv/apps/nanoclaw/` → `/srv/apps/nanoclaw-pre-v2/`, then `/srv/apps/nanoclaw-v2/` → `/srv/apps/nanoclaw/`.

Option B requires regenerating v2's install slug (path-derived) and reinstalling the systemd unit with the new slug. Option A doesn't.

Document the choice in `docs/v2-migration/post-cutover-notes.md`.

**Verification:**

```bash
ls -d /srv/apps/nanoclaw* 2>&1
# Matches the chosen layout
systemctl --user list-units --state=active | grep nanoclaw
# v2 unit still active under whichever slug applies
```

**Rollback:**

If the rename breaks the running service, stop it, rename back, recompute slug, reinstall unit, restart.

**Notes:**
Option A is simpler; Option B preserves muscle memory but adds risk. Default to A unless there's a specific reason to swap paths.

---

#### W8.6: Schedule v1 tombstone

**Action:**

Pick a date 30 days from cutover. On that date:

1. Confirm v2 has been operating without incident.
2. Move `~/backups/nanoclaw-cutover-v1-*.tar.gz` offsite (e.g., backblaze, S3, encrypted USB).
3. Delete `/srv/apps/nanoclaw-pre-v2/`.

Schedule via the agent's own scheduler — ask it to schedule a task 30 days out that surfaces a reminder.

**Verification:**

Reminder fires at the scheduled date.

**Rollback:** cancel the scheduled task if circumstances change.

---

## 6. Kill criteria

Abort the migration and revert to v1 if any of these conditions arise:

1. ~~**W6.7 (subscription-billing wire verification) fails.**~~ **RETIRED post-P3.** The `/api/oauth/usage` query returned `extra_usage.is_enabled=false` at the org level with `disabled_reason="org_level_disabled_until"` — spillover to a non-subscription bucket is structurally impossible, irrespective of how OneCLI's MITM behaves. five_hour / seven_day / seven_day_sonnet counters confirmed advancing under v2 traffic. See [p3-notes.md](p3-notes.md) §3.3.
2. **Upstream introduces another breaking change** during the migration we can't absorb. Check `CHANGELOG.md` in `upstream/main` weekly during the migration window.
3. **Critical fork-local feature has no port path on v2 AND no workaround.** Remote-control (W4.6) is the canonical example — if it turns out incompatible with v2's session model and we depend on it, we stop.
4. **More than 2 days of cumulative downtime during cutover (P7).** **Post-P3 update:** cutover effectively happened during P3 W3.6; total downtime was ~90 minutes (W3.1 stop until W3.6 smoke test completes). Threshold not exceeded. See [p3-notes.md](p3-notes.md) §3.1.

---

## 7. Master rollback plan

Rollback granularity depends on where in the plan we are:

- **Before P3 (data migration):** delete `/srv/apps/nanoclaw-v2/`. v1 is still running, no production impact.
- **After P3 but before P7 (cutover):** v1 still running. Delete v2 install dir. No production impact. `migrate-v2.sh` does not modify v1.
- **After P7 (cutover):**
  1. Stop v2 service: `systemctl --user stop $(cat /tmp/v2-unit-name)`
  2. Disable v2: `systemctl --user disable $(cat /tmp/v2-unit-name)`
  3. Restart v1: `systemctl --user enable nanoclaw.service && systemctl --user start nanoclaw.service`
  4. If v2's DB or channel state was corrupted, restore from W7.1's backup (accepting that any messages received in the v2 window are lost).
- **Master backup:** git tag `pre-v2-migration-<YYYYMMDD>` (from W0.2) + tarball at `~/backups/nanoclaw-pre-v2-<timestamp>.tar.gz` (from W0.3) + cutover tarball at `~/backups/nanoclaw-cutover-v1-<timestamp>.tar.gz` (from W7.1).

---

## 8. Operational notes

1. **`migrate-v2.sh` and v2's `setup.sh` / `nanoclaw.sh` must run from a real terminal**, not the Claude Code Bash tool. These scripts collapse non-TTY stdin/stdout — interactive prompts won't render and they will hang or fail in odd ways. (P1 spike confirmed this for the installer; same applies to the migrator.)
2. **During parallel run (P2–P6), v1 owns host port 3002 (health).** v2 uses 4002 until W7.4 swaps it back. The fork's custom credential proxy (v1's 3001) is retired on v2 — only v1 still listens on 3001 during parallel run, and the port is freed at cutover when v1 stops.
3. **Docker socket access is shared between v1 and v2 during parallel run.** Docker handles concurrent clients fine, but watch for image-build cache contention if both are rebuilding the agent container simultaneously.
4. **v2 install slug.** Pre-P2 the plan predicted `9c12bd9b` for `/srv/apps/nanoclaw-v2/` based on the spike-era `sha1(path)[:8]` algorithm. **Actual v2.0.64 slug is `787facac`** — the slug algorithm changed between the spike (v2.0.0-era) and P2 install (v2.0.64). Real unit name: `nanoclaw-v2-787facac.service`. Real image tag: `nanoclaw-agent-v2-787facac:latest`. Resolve manually for any new install via `. setup/lib/install-slug.sh && systemd_unit` from inside the v2 dir. The slug changes if you rename the project directory (see W8.5).
5. **Subscription auth refresh:** if the `sk-ant-oat01-…` OAuth token expires during the migration window, run `claude setup-token` to capture a fresh one. Update **v1's** `.env` (v1 reads the token from `.env`) AND **v2's** OneCLI vault entry (`onecli secrets update Anthropic --value $token` or recreate). Until cutover, both must be in sync. Do not paste the token into chat or commit it to git.
6. **WhatsApp Baileys keystore does not support concurrent sessions.** Only one of v1 and v2 can hold the WA session at a time. During parallel testing (W5.2), either use a throwaway WA number or briefly stop v1 for the test.
7. **Test in production-adjacent test channels, not production channels**, until W7.8. Use dedicated `#test` Slack channels, throwaway WA contacts, and a test Gmail label.
8. **Don't skip W0.5 (fork-local inventory).** P4 is unworkable without it — the inventory is the only systematic record of what needs porting.
9. **`/srv/apps` is root-owned on this host** (surfaced by P1 spike). W2.1's `git clone` will fail without a prior `sudo mkdir -p /srv/apps/nanoclaw-v2 && sudo chown john:john /srv/apps/nanoclaw-v2` (or equivalent).
10. **`pnpm` is at `~/.npm-global/bin/pnpm`** but not on the Claude Code Bash tool's default PATH. Prefix `pnpm` calls with `PATH="/home/john/.npm-global/bin:$PATH"` or use the absolute path.
