# 2026-05-26 — Default agent model is now Opus 4.7

## What changed

Every NanoClaw agent group now defaults to `claude-opus-4-7`. Previously the `container_configs.model` column was nullable, and every existing row (all 11 agent groups) had NULL. When `model` is NULL, the agent-runner passes `undefined` to the Claude Agent SDK, which auto-selects whatever default the SDK ships with — currently a Sonnet variant. John wants quality over speed across the board.

## Why

John uses NanoClaw conversationally via Slack and WhatsApp. Latency on these channels is dominated by container spin-up + tool calls, not by which Claude model is chosen, so dropping to Sonnet doesn't materially improve perceived speed. The quality difference on harder questions does matter. Standing instruction going forward: **default to Opus 4.7 everywhere; never silently fall back to Sonnet or Haiku.**

The wording in the ask was "all slack channels," but the natural extension is global — there's no per-channel-type knob for model selection, and "I don't want to use other models" generalizes cleanly. Confirmed scope with John before implementing.

## How

Three files changed, one new migration, one new test file.

**`src/db/container-configs.ts`**

```ts
export const DEFAULT_MODEL = 'claude-opus-4-7';

export function ensureContainerConfig(agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO container_configs (agent_group_id, model, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(agentGroupId, DEFAULT_MODEL, new Date().toISOString());
}
```

`ensureContainerConfig` is the single insert path for new agent groups (called from `initGroupFilesystem`). Adding `model` to the `INSERT OR IGNORE` means new groups get Opus 4.7 from row creation; the `OR IGNORE` keeps it from clobbering an already-set model on re-init.

**`src/db/migrations/017-default-model-opus.ts`** (new)

```ts
db.prepare("UPDATE container_configs SET model = 'claude-opus-4-7' WHERE model IS NULL OR model = ''").run();
```

The migration handles both NULL (the common case) and empty string (which the `job-search-ritsya` group somehow had — probably set via `ncl groups config update --model ""` during creation). Idempotent: re-running after every row is Opus 4.7 changes nothing. The model literal is hardcoded rather than imported from `DEFAULT_MODEL` because migrations are point-in-time records — when `DEFAULT_MODEL` eventually moves to 4.8, migration 017's behavior must stay frozen.

**`src/db/container-configs.test.ts`** (new) — 4 tests:

1. `ensureContainerConfig` seeds `DEFAULT_MODEL` on new rows.
2. An explicit model override is not clobbered by a subsequent `ensureContainerConfig` call.
3. The migration UPDATE rewrites NULL values to the default.
4. The migration UPDATE also rewrites empty-string values.

Tests 3 and 4 use the same SQL string as the migration itself rather than calling `migration017.up()` — guards against the SQL string drifting between the migration file and the test.

## Rollout

The full sequence executed in this session:

1. Code changes + tests written and verified (`pnpm exec vitest run` — 486/486 host, 127/127 container).
2. `UPDATE container_configs SET model = 'claude-opus-4-7' WHERE model IS NULL OR model = ''` applied directly to the live DB so the change takes effect without waiting for service restart.
3. `pnpm run build` to compile the new host code.
4. `systemctl --user restart nanoclaw-583cc1c4.service` — picks up new code; migration 017 records itself in `schema_version` (the UPDATE part is a no-op since data already matches).
5. Verified no agent containers were running. Idle containers = no restart needed. Next message to any group spawns a fresh container; `materializeContainerJson()` writes the current DB value into `groups/<folder>/container.json`; the agent-runner reads it and passes `model: 'claude-opus-4-7'` to the SDK.

## Gotchas worth noting

- The `slack_job-search-ritsya/container.json` file on disk had `"model": ""` rather than being absent — old materialization wrote empty strings instead of omitting the field. The migration SQL handles this case, and the next spawn will overwrite the on-disk file with the populated value anyway.
- The agent-runner's `ClaudeProvider` passes `this.model` directly to the SDK options at `container/agent-runner/src/providers/claude.ts:438`. No translation layer — if a future operator sets `model = 'sonnet'` (alias) or `model = 'claude-haiku-4-5-20251001'` (full ID), it'll work the same way. The SDK accepts both aliases and full IDs.
- `backfill-container-configs.ts` is the legacy-migration path from v1 `container.json` files. It writes `model: null` because there's no legacy concept of "model" at the v1 layer. Migration 017 normalizes that NULL afterward. Not worth changing the backfill itself — it's effectively dead code post-v1-to-v2 cutover.

## Memory

Saved `feedback_default_model_opus.md` so future sessions know:
1. Default is Opus 4.7. Don't propose Sonnet/Haiku unless John asks for them by name.
2. NULL and empty-string `model` values both count as "unset" and get normalized by migration 017.
3. The constant lives in `src/db/container-configs.ts`; the agent-runner reads through to the SDK with no translation.
