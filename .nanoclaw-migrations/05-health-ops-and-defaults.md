# Section 05 — Health/Ops, Slash Commands & Defaults

> Recover bodies with `git show 971239a:<path>`.

The `/status` and `/usage` chat commands share a host-responder path through the command gate +
router. Apply the shared `respond` plumbing ONCE (below), then each command plugs in.

---

## 5.1 Shared host-responder `respond` gate action

**Origin:** fork-original. **Commits:** `e968b39` (/usage), `600be3b` (/status).
**Files:** `src/command-gate.ts`, `src/router.ts`, `src/session-manager.ts`, `src/delivery.ts`,
`src/host-sweep.ts`.

Apply:
1. `src/command-gate.ts`: add `{ action:'respond'; command:string; render:()=>Promise<string> }`
   to the `GateResult` union; add `const HOST_RESPONDER_COMMANDS: Record<string, ()=>Promise<string>>
   = { '/usage': () => getUsageText(), '/status': async () => formatHealthText(snapshotHealth()) }`;
   in `gateCommand`, check `HOST_RESPONDER_COMMANDS[command]` BEFORE the admin-command check →
   return `{action:'respond', command, render}` if admin else `{action:'deny', command}`. Import
   `getUsageText` (§5.3), `formatHealthText` + `snapshotHealth` (§5.2).
2. `src/router.ts`: in `deliverToAgent`, after the `gate.action === 'deny'` block add a
   `gate.action === 'respond'` block — call `gate.render()` off the hot path, write the result via
   `writeOutboundDirect`, write an inline error message on failure (~40 lines — recover verbatim).
3. `src/session-manager.ts`: `writeOutboundDirect` must open RW (`openOutboundDbRw`). Current HEAD
   already has this (`d8c04b8`); upstream also has it (`eef285b`) — verify it's RW after build.
4. `src/delivery.ts`: add `export function getDeliveryPollsRunning(): boolean { return activePolling
   && sweepPolling; }`.
5. `src/host-sweep.ts`: add `export function isHostSweepRunning()` (reads its `running` flag).

> Decision #1 note: the fork's router/delivery also DROPPED upstream's `instance`-aware routing
> (no `instance` arg on lookups/typing/deliver). Do NOT carry those removals — keep upstream's
> instance-aware signatures and only ADD the `respond` branch + `getDeliveryPollsRunning` on top.

---

## 5.2 `/health` endpoint + systemd watchdog + `/status`

**Origin:** fork-original. **Commits:** `0638657` (/health + watchdog), `600be3b` (/status).
**Files:** `src/health.ts` (new), `src/health-server.ts` (new), `src/health-snapshot.ts` (new),
`src/watchdog.ts` (new), `src/index.ts`, plus the shared gate (§5.1).

Apply:
1. Copy the four new files verbatim: `health.ts` (exports `collectHealth`, `formatHealthText`,
   `formatAge`), `health-server.ts` (`startHealthServer`, loopback port 3002), `health-snapshot.ts`
   (`snapshotHealth` — pulls live runtime state incl. `getActiveAdapters` from the channel
   registry, `getDeliveryPollsRunning`, `isHostSweepRunning`), `watchdog.ts` (`initWatchdog` —
   `sd_notify` READY=1 + WATCHDOG=1 ticks).
2. `src/index.ts`: import `http`, `snapshotHealth`, `startHealthServer`, `initWatchdog`/`Watchdog`.
   Add module vars (`healthServer`, `watchdog`, `watchdogTimer`, `WATCHDOG_TICK_MS=2000`,
   `DEFAULT_HEALTH_PORT=3002`). After the CLI-server step, start the health server + init the
   watchdog with a 2s interval. In `shutdown()`, clear the timer, `watchdog?.close()`, await
   `healthServer?.close()`. (The fork also replaced `createChannelDeliveryAdapter()` with an inline
   adapter object using `getChannelAdapter` — only re-apply if upstream still has the old factory;
   otherwise adapt to upstream's current delivery wiring.)
3. **Do NOT** carry the fork's removal of `enforceUpgradeTripwire` from `index.ts` — per the
   migration goal we're going TO clean upstream (which has the 2.1.0 tripwire). Keep upstream's
   tripwire; ensure the install boots (stamp `data/upgrade-state.json` via the 2.1.0 upgrade path).
4. `setup/service.ts` + `setup/service.test.ts` (commits `7cde667`, `97abc95`): bake watchdog flags
   into the generated systemd unit — replace `Type=simple` with `Type=notify` + `NotifyAccess=all`
   + `WatchdogSec=30s` (fresh installs only); update the test snapshot + add 3 assertions.

---

## 5.3 `/usage` command + `ncl usage` CLI

**Origin:** fork-original. **Commits:** `e968b39`, `61c17cc`. **Files:** `src/usage.ts` (new),
`src/cli/commands/usage.ts` (new), `src/cli/commands/index.ts`, `src/command-gate.ts` (§5.1).

Apply: copy `src/usage.ts` (~335 lines: reads OAuth creds from `~/.claude/.credentials.json`,
auto-refreshes token, GETs `https://api.anthropic.com/api/oauth/usage`; constants `OAUTH_CLIENT_ID
= '9d1c250a-e61b-44d9-88ed-5944d1962f5e'`; exports `fetchUsage`, `getUsageText`, `formatUsage`,
`getValidAccessToken`, `renderProgressBar`, etc.). Copy `src/cli/commands/usage.ts` (~20 lines,
registers `ncl usage`). In `src/cli/commands/index.ts` add `import './usage.js';` before
`registerResourceHelpCommands()`. The `/usage` chat path is wired by the shared gate (§5.1) —
don't duplicate. NB: does NOT use the OneCLI vault (OAuth bearer path); shares the credentials
file with Claude Code (token refresh writes back).

---

## 5.4 Default model Opus 4.7 (migration 017)

**Origin:** fork-original. **Commit:** `3b66e91`. **Files:** migration `017-default-model-opus.ts`
(renumber), `src/db/container-configs.ts`, `src/db/container-configs.test.ts`.

Apply: migration `UPDATE container_configs SET model = 'claude-opus-4-7' WHERE model IS NULL OR
model = ''`. In `container-configs.ts` add `const DEFAULT_MODEL = 'claude-opus-4-7';` and use it in
the `ensureContainerConfig` INSERT (instead of empty/NULL); ensure `updateContainerConfigScalars`
Pick includes `model`. Recreate `container-configs.test.ts` (~134 lines — also covers env round-trip
from §4.1 and budgets from §1.5; create it once covering all three). **If upstream already seeds a
default model, verify it's `claude-opus-4-7` before overwriting.**

---

## 5.5 Per-channel `reply_mode` (migrations 016 + 018)

**Origin:** fork-original. **Commits:** `59540d7` (reply_mode), `90fb3f8` (default 'channel').
**Files:** migrations `016-reply-mode.ts` + `018-reply-mode-channel-default.ts` (RENUMBER — see
below), `src/db/schema.ts`, `src/db/messaging-groups.ts`, `src/db/db-v2.test.ts`, `src/types.ts`,
`src/delivery.ts`, `src/cli/resources/messaging-groups.ts`.

Intent: `reply_mode` column on `messaging_groups` (`'thread'`|`'channel'`); when `'channel'`, the
delivery loop strips the inbound `thread_id` so replies land in the channel root.

**CRITICAL (decision #1):** Upstream's `016-messaging-group-instance.ts` STAYS. The fork had
replaced 016 with reply-mode and stripped the instance column — do NOT do that. Instead:
1. Add reply-mode as a NEW migration at the next free number (after upstream's highest):
   `ALTER TABLE messaging_groups ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'thread'`.
2. Add the channel-default migration at the next number after that:
   `UPDATE messaging_groups SET reply_mode = 'channel' WHERE reply_mode != 'channel'`.
3. `src/db/schema.ts`: add `reply_mode TEXT NOT NULL DEFAULT 'channel'` to the `messaging_groups`
   CREATE TABLE (LEAVE upstream's `instance` column in place).
4. `src/db/messaging-groups.ts`: add `reply_mode` to `createMessagingGroup` INSERT (default
   `'channel'`) and to the `updateMessagingGroup` Pick. Keep upstream's instance-aware lookups.
5. `src/types.ts`: export `ReplyMode`; add `reply_mode?: ReplyMode` to `MessagingGroup` (keep
   upstream's `instance?: string`).
6. `src/delivery.ts`: in `deliverMessage`, after resolving `mg`,
   `let effectiveThreadId = msg.thread_id; if (mg.reply_mode === 'channel') effectiveThreadId =
   null;` and pass `effectiveThreadId` to the adapter `deliver(...)`.
7. `src/cli/resources/messaging-groups.ts`: add a `reply_mode` field (enum `['thread','channel']`,
   default `'channel'`, updatable).
8. Recreate the `reply_mode` cases in `db-v2.test.ts`.

---

## 5.6 OneCLI identifier sanitization (`oc-` prefix)

**Origin:** fork-original. **Commit:** `f3143a9`. **Files:** `src/onecli-identifier.ts` (new),
`src/container-runner.ts`, `src/modules/approvals/onecli-approvals.ts`.

Intent: OneCLI's `POST /api/agents` requires identifiers to start with a letter, but raw UUIDs
start with a digit ~62% of the time → silent `400`. Prefix digit-leading group IDs with `oc-`;
reverse for approval routing.

Apply:
1. Create `src/onecli-identifier.ts` (verbatim, ~29 lines):
   ```ts
   const PREFIX = 'oc-';
   export function toOneCliIdentifier(groupId: string): string { return /^[a-z]/.test(groupId) ? groupId : PREFIX + groupId; }
   export function fromOneCliIdentifier(identifier: string): string { return identifier.startsWith(PREFIX) ? identifier.slice(PREFIX.length) : identifier; }
   ```
2. `src/container-runner.ts`: `import { toOneCliIdentifier } from './onecli-identifier.js';` and set
   `const agentIdentifier = toOneCliIdentifier(agentGroup.id);` where `ensureAgent` is called.
3. `src/modules/approvals/onecli-approvals.ts`: import `fromOneCliIdentifier`; wrap the
   `originGroup` lookup: `getAgentGroup(fromOneCliIdentifier(request.agent.externalId))`.
4. Recreate `onecli-identifier.test.ts`.

**Operational note:** OneCLI agents created earlier under un-sanitized IDs will get a NEW agent
entry on next spawn (old one orphaned in the vault) — redo secret assignment via `onecli agents
set-secret-mode --mode all` (see CLAUDE.md OneCLI gotcha).

---

## 5.7 create_agent provider-inheritance removal (OPTIONAL)

**Origin:** fork-original delta on top of upstream's `58e018f` (which is already on HEAD + upstream).
**Files:** `src/modules/agent-to-agent/create-agent.ts` + `.test.ts`.

Per decision #1 (prefer upstream behavior), this is OPTIONAL. The fork removed child-agent
provider inheritance (dropped the `updateContainerConfigScalars` import + the `parentProvider`
block + two test cases). Since you're Claude-only, provider inheritance is a no-op for you either
way — recommend LEAVING upstream's version as-is and skipping this delta. Only apply if you
specifically want the leaner code.
