# Upstream cherry-pick agent broke the build

CI was failing on every push to main. The `chore:` and `docs:` commits from GitHub Actions bots
were all red, generating "run failed" notifications in the GitHub iOS app. Investigation revealed
two separate problems, one masking the other.

## Problem 1: `gh` CLI was pointing at the wrong repo

`gh repo view` returned `qwibitai/nanoclaw` (the upstream) instead of `johnmathews/nanoclaw` (our
fork). This meant `gh pr list`, `gh run list`, etc. were showing upstream activity — hundreds of
PRs from random external contributors that had nothing to do with us. The `action_required`
conclusion on fork PRs (GitHub's approval requirement for first-time contributors) was showing
as "run failed" in notifications.

**Fix:** `gh repo set-default johnmathews/nanoclaw` to pin the CLI to our fork.

## Problem 2: The real CI failures — broken TypeScript from incomplete cherry-picks

Once looking at our actual fork's CI runs, all three recent runs were genuinely failing at the
typecheck step. The errors:

### 2a. `getMessagesSince` — call sites updated, function signature not

Commit `976ac94` (`exe.dev user`: "fix: prevent full message history from being sent to container
agents") added a 4th `limit` parameter to all three `getMessagesSince()` call sites in
`src/index.ts` and all three test call sites in `src/db.test.ts`. But the function definition
in `src/db.ts` was **not updated** to accept the parameter. Upstream had both halves of the
change; our fork only got the call-site half.

The upstream function signature is:
```typescript
getMessagesSince(chatJid, sinceTimestamp, botPrefix, limit = 200)
```

Our fork still had the 3-argument version. The cherry-pick applied cleanly (no merge conflicts)
because the call sites and function definition are in different files — git saw no textual
overlap, so it applied half the change silently.

### 2b. Duplicate `deleteSession` import

Commit `1913c40` (`Gary Walker`: "fix: recover from stale Claude Code session IDs") added
`deleteSession` to the imports in `src/index.ts`. But our fork already had `deleteSession`
imported (from our own earlier work at `0ec6d2f`). The cherry-pick added a second copy,
creating a duplicate identifier error.

### 2c. `exec()` wrapper around `stopContainer()` — wrong calling convention

The `killOnTimeout` function in `src/container-runner.ts` used `exec(stopContainer(name), ...)`
but `stopContainer()` returns `void` (it uses `execSync` internally). `exec()` expects a string
command. Upstream uses a simple `try/catch` around `stopContainer()` directly. The `exec()`
wrapper was introduced by a cherry-pick that didn't match our codebase's version of the function.

## Root cause: the Slack monitoring agent

A NanoClaw agent running in a Slack channel monitors upstream `qwibitai/nanoclaw` activity and
cherry-picks commits and features into our fork. This agent is making mistakes:

1. **Partial cherry-picks**: When an upstream commit spans multiple files, the cherry-pick can
   apply cleanly in git (no textual conflicts) while being semantically broken. The agent
   doesn't verify that the result compiles or passes tests after cherry-picking.

2. **Duplicate work**: The agent cherry-picked changes that overlap with work already done
   locally (the `deleteSession` function), creating duplicate code.

3. **Blind trust in clean merges**: Git's merge machinery only detects textual conflicts. A
   change that adds a parameter to call sites in file A and updates the function signature in
   file B will merge cleanly even if only file A's changes are applied — because there's no
   textual overlap. The agent needs to run `tsc --noEmit` and `npm test` after every cherry-pick.

## What we fixed

1. Added `limit: number = 200` parameter to `getMessagesSince()` in `src/db.ts`, matching
   upstream's signature (subquery with `LIMIT` and re-sort)
2. Removed duplicate `deleteSession` import from `src/index.ts`
3. Replaced `exec(stopContainer())` with `try { stopContainer() } catch` in
   `src/container-runner.ts`, matching upstream
4. Removed unused `exec` import from `child_process`
5. Skipped CI for fork PRs in `.github/workflows/ci.yml` to prevent `action_required` noise
6. Fixed `gh` CLI default repo to point at our fork

## Follow-up: stray conflict marker broke all containers

The initial fix (commit `142d2c7`) resolved the host-side TypeScript errors but left a
`<<<<<<< HEAD` merge conflict marker at line 393 of `container/agent-runner/src/index.ts`.
This went unnoticed because the host build succeeded — the agent-runner source is not compiled
at build time. It's mounted into containers at runtime and compiled there via `npx tsx`.

**Symptom:** Every container spawn crashed immediately with `TS1185: Merge conflict marker
encountered`. Messages across all channels (main-group, server-bot, git-maintenance) were
retried up to 6 times then dropped. The only visible sign in Slack was the `:eyes:` typing
indicator appearing and disappearing repeatedly (added on spawn, removed on crash, re-added
on retry).

**Fix:** Removed the stray `<<<<<<< HEAD` line (`51154e9`).

**Why it wasn't caught:** The agent-runner lives in `container/agent-runner/src/` and is only
compiled inside Docker containers at runtime. `npm run build` only compiles the host code in
`src/`. There is no CI step that typechecks the agent-runner source. This is a gap — the
cherry-pick verification lesson below should include the agent-runner.

## Follow-up: broken test suite

Three tests were also failing, masking CI's ability to catch real regressions:

1. **mount-security.test.ts — wrong mock target**: The test mocked `pino` to spy on logger
   calls, but `logger.ts` was rewritten as a custom logger (no pino dependency). The mock
   was targeting a module that's no longer imported. Fixed by mocking `./logger.js` directly.

2. **mount-security.test.ts — wrong cache expectation**: Test expected file-not-found to be
   cached (single `existsSync` call), but the code explicitly does NOT cache this case
   (comment: "file may be created later without restart"). Fixed test to expect 2 calls and
   added a separate test for parse error caching (which IS permanent).

3. **claw-skill.test.ts — timeout race**: Default 5s vitest timeout was too tight. The test
   spawns a mock container with `sleep 30` that ignores SIGTERM, requiring a 5s grace period
   before SIGKILL. The test was timing out before the kill could complete. Fixed by increasing
   test timeout to 20s.

## Lessons for the upstream monitoring agent

The agent's cherry-pick workflow MUST include post-application verification:
```
git cherry-pick <sha>
npm run build        # catches type errors
npx vitest run       # catches runtime errors
# if either fails: git cherry-pick --abort and report the failure
```

Without this, every cherry-pick is a gamble that git's textual merge happened to also be a
semantic merge — and as we saw, it often isn't.
