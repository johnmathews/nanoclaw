---
date: 2026-03-17
tags: [fix, decision]
---

# Slack Working Indicator: Debugging Retrospective

## What

During implementation of the Slack working indicator and live progress feature, debugging the container-side changes
took significantly longer than necessary due to not understanding the agent-runner-src bind mount.

## The problem

Progress markers were being emitted by the agent-runner code, but the running containers never executed the updated
code. The container image was rebuilt multiple times, the service restarted repeatedly, but the changes never took
effect. This led to ~5 wasted rebuild/restart/test cycles.

## Root cause

Container agents bind-mount `data/sessions/{group}/agent-runner-src/` over `/app/src` inside the container. This
shadows whatever the Docker image contains. The mount was only populated on first run (`!fs.existsSync` check), so
subsequent image rebuilds had no effect on existing groups.

The entrypoint recompiles TypeScript at runtime (`npx tsc --outDir /tmp/dist`), so the container always compiles from
the mounted source — not from the image's built-in copy.

## How it was found

1. `docker run --rm --entrypoint grep nanoclaw-agent:latest "PROGRESS" /app/src/index.ts` showed the code existed in
   the image
2. `docker exec <running-container> grep "PROGRESS" /app/src/index.ts` showed it did NOT exist in the running container
3. `docker inspect <container> --format "{{json .Mounts}}"` revealed the bind mount over `/app/src`

Step 3 should have been step 1. The key debugging principle: **always check what the running process actually sees, not
what the image contains.**

## Fix

Changed `container-runner.ts` to always sync the source:

```typescript
// Before (only copies once)
if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
  fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
}

// After (always syncs)
if (fs.existsSync(agentRunnerSrc)) {
  fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
}
```

This means agent-runner code changes now take effect on the next container spawn without needing a container image
rebuild.

## Lessons

1. **Check mounts first** when container behavior doesn't match the image — bind mounts shadow image contents silently
2. **`docker inspect` the running container** rather than `docker run` from the image — they can behave differently
3. **Minimize rebuild cycles** — when debug output doesn't appear, verify the running process has the code before
   rebuilding again
4. **The entrypoint matters** — this container recompiles TS at runtime from `/app/src`, so the image's pre-built
   `/app/dist` is irrelevant when the source mount is present
