# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

### House style

- **Commit messages.** Short imperative subject line (`feat:`/`fix:`/`docs:`/`chore:` prefix optional but common —
  scan recent `git log --oneline` to match the local style). Body explaining *why* if non-obvious. No emoji.
- **Branch.** Target `main`.
- **Format.** `npm run format` (Prettier) before commit; CI checks `npm run format:check`.
- **Build + test.** `npm run build && npm test` must be green before opening a PR.
- **Tests.** Every code change ships with tests (`src/<thing>.test.ts`). Bug fixes ship with a regression test that
  fails before the fix and passes after.

## Skills

A [skill](https://code.claude.com/docs/en/skills) lives at `.claude/skills/<name>/SKILL.md` and teaches Claude Code how
to transform a NanoClaw installation. A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Claude follows to add the feature — not pre-built code. See
[`.claude/skills/add-telegram/SKILL.md`](.claude/skills/add-telegram/SKILL.md) for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add
features to their fork without inheriting code for features they don't want.

### Testing a skill

Test your skill by running it on a fresh clone before submitting. For source-code changes (the rare ones we accept),
run `npm test` and confirm all tests pass before opening a PR.

### Skill branches and the rebase rule

Skills are distributed as git branches (`skill/<name>`) or as separate remotes for channel skills. **CI rejects skill
branches that contain merge commits from `main`** — branches must be rebased onto current `main` before merging, never
merged directly. See [docs/skills-as-branches.md](docs/skills-as-branches.md) (specifically *The Rebase-onto-Main Rule*)
for the full workflow.

## Why no GHCR container image?

This fork deliberately doesn't publish its container image to `ghcr.io`. The project model is per-user forks: every
user runs `./container/build.sh` locally so their container bakes in their own customizations (mounts, skills,
credentials). Publishing a "canonical" image for this fork would broadcast fork-local features as if they were a
shared baseline, which contradicts the design.
