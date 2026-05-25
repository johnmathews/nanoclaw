# Remove v1 install and drop "v2" suffix from generated identifiers

Date: 2026-05-25. Tags: ops, rename.

`/srv/apps/nanoclaw-v2` is now `/srv/apps/nanoclaw`, the legacy v1 install at
`/srv/apps/nanoclaw` is gone, and `install-slug.ts` / `install-slug.sh` no
longer encode `-v2-` in the systemd unit, launchd label, docker image, or
container name prefix.

## Why

v1 hadn't been used since the v2 migration finished on 2026-05-21 — no
service pointed at it, no process touched it, the `launchd/` folder inside
was a stale leftover from when v1 ran on macOS. The directory was holding
~52 MB of unreachable state and the `-v2` suffix in service/image names was
warning about a multi-install scenario that no longer existed.

## Scope decisions (front-loaded before any work)

Three explicit gates via `AskUserQuestion` to keep the rename from quietly
ballooning:

1. **Back up v1, then delete.** Tarballed to `nanoclaw-v1-backup-20260525.tar.gz`
   (413 MB, 26,512 files) and gitignored. Cheap insurance against "I needed
   that thing in v1's `.env`."
2. **Rename scope: identifier-only, not data-layout.** "v2" was woven through
   the code in three categories of decreasing safety:
   - **Install identifiers** (4 lines in `install-slug.ts` + `install-slug.sh` +
     `container-runner.ts:135`): cosmetic, safe to patch.
   - **On-disk data layout** (`data/v2.db`, `data/v2-sessions/`, referenced in
     ~10 files): would mean moving live SQLite files, updating mount paths in
     every running session container, editing files across `src/` and `setup/`.
     Real risk, zero functional benefit. Skipped.
   - **Wire-format identifiers** (`ncv2:` action ID prefix in `chat-sdk-bridge.ts`,
     `Ncv2InboundInput` types): the `ncv2:` prefix is embedded in Slack/Telegram
     interactive button IDs already sitting in chat history — renaming it would
     break any button a user clicks from an old message. Skipped.
3. **Brief outage, no draining.** Three Slack `git-maintenance` session
   containers were live; stopping the host doesn't kill its container children,
   so `docker stop` on each before the directory rename. Lost work was bounded
   to in-flight tool calls.

## Implementation

Per-checkout install slug is `sha1(projectRoot)[:8]`, so a directory rename
deterministically changes the slug. Pre-rename slug: `787facac`. Post-rename:
`583cc1c4`. That means the existing systemd unit and built docker image
become stale references the moment `mv` runs.

Order mattered:

1. **Backup + stop.** `tar -czf` to `/tmp`, `systemctl --user stop`,
   `docker stop` for the three live containers.
2. **Disable + remove old systemd unit** before the rename, while the old
   slug is still meaningful.
3. **Patch source identifiers** in `src/install-slug.ts` (3 lines),
   `setup/lib/install-slug.sh` (3 printf lines + 3 docstring lines),
   `src/container-runner.ts:135` (1 line). Slug suffix stays — only the
   `-v2-` between `nanoclaw` and the slug is dropped.
4. **Delete v1, rename v2.** Both required `sudo` because `/srv/apps` is
   root-owned; combined into one `sudo bash -c 'rm && mv'` to minimize
   the privileged surface.
5. **Re-register.** `pnpm exec tsx setup/index.ts --step service` (the
   dispatch entrypoint — invoking `setup/service.ts` directly silently
   no-ops because it only exports `run()`, doesn't call it). The script
   rebuilds TS, writes the new unit file, daemon-reloads, starts the
   service, and updates `~/.local/bin/ncl` to point at the new path.
6. **Rebuild image.** `./container/build.sh` reads `$PROJECT_ROOT` via
   the same `install-slug.sh` and produces `nanoclaw-agent-583cc1c4:latest`.
7. **Prune.** Deleted the old `nanoclaw-agent-v2-787facac:latest` image,
   the orphaned `nanoclaw-agent:latest` from an earlier dev run, and four
   stale `nanoclaw-main-*` containers in `Created` state.

Post-rename test failures were narrow and predictable: two host vitest
assertions hardcoded `-v2-` in the regression patterns they were guarding
against. Updated to `(?!-[0-9a-f])` so they still catch the underlying
regression (bare label/unit names without a per-install slug suffix) without
encoding the specific slug shape.

## Trailing cleanup

Dropped the `⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️` banner from the
top of `CLAUDE.md`. That banner warned about merging upstream v2 changes into
an existing v1 install, which can't happen here anymore. The actual project
doc now starts at `# NanoClaw` directly.

## What we didn't touch

- `data/v2.db` and `data/v2-sessions/` keep their names.
- `ncv2:` action-ID prefix in `chat-sdk-bridge.ts` stays.
- `Ncv2InboundInput` type name stays.
- `setup/migrate-v2/` and `docs/v2-migration/` (historical v1→v2 migration
  scripts and notes) left alone — still useful documentation for anyone
  reading the repo to understand how v2 came about.
- README's "Migrating from NanoClaw v1?" block stays — it's canonical for
  other v1 users following the same path.
