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

## Files

- `src/group-config.ts` — new module
- `src/group-config.test.ts` — 14 tests
- `src/container-runner.ts` — reads config, injects `ANTHROPIC_MODEL`
- `src/container-runner.test.ts` — added mock for group-config
- `groups/slack_git-maintenance/config.json` — sets opus (gitignored)
