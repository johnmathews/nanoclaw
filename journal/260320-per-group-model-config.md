# Per-Group Model Configuration

## What

Added the ability to configure which Claude model each group uses via a
`groups/{folder}/config.json` file. If a `model` field is present, it's
resolved (aliases like `"opus"` → `"claude-opus-4-6"`) and passed as the
`ANTHROPIC_MODEL` env var to the container.

## Why

Different groups have different needs. The git-maintenance group benefits from
Opus-level reasoning for complex repo operations, while most groups are fine
with Sonnet (the SDK default). A file-based config was chosen over DB because:

- Easy to read and edit manually
- The agent itself can modify it from inside the container (the group folder is
  mounted read-write)
- No schema migration needed

## Design decisions

- **No caching:** Config is read on every container spawn. This keeps the code
  simple and means edits take effect immediately without restarts.
- **Alias map:** Short names (`opus`, `sonnet`, `haiku`) resolve to full model
  IDs. Unknown strings pass through unchanged, so new model IDs work without
  code changes.
- **Graceful degradation:** Missing file → `{}`, invalid JSON → warn + `{}`,
  non-string model → `{}`. The container just gets the SDK default.
- **Explicit SDK model passing:** Initially the model was only passed as an env
  var (`ANTHROPIC_MODEL`) on the container, relying on the CLI subprocess to
  read it. This was fragile — it depended on an implementation detail of how
  the SDK spawns the CLI. Fixed by having the agent-runner read
  `process.env.ANTHROPIC_MODEL` and pass it directly as `options.model` to
  `query()`, which is the SDK's documented interface. The env var is still set
  (belt and suspenders), but the explicit option is the primary mechanism.

## Files

- `src/group-config.ts` — new module
- `src/group-config.test.ts` — 14 tests
- `src/container-runner.ts` — reads config, injects `ANTHROPIC_MODEL` env var
- `src/container-runner.test.ts` — added mock for group-config
- `container/agent-runner/src/index.ts` — reads env var, passes as `options.model`
- `groups/slack_git-maintenance/config.json` — sets opus (gitignored)
