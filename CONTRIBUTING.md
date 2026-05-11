# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to
transform a NanoClaw installation.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** Claude follows to add the feature—not pre-built code. See `/add-telegram`
for a good example.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features
to their fork without inheriting code for features they don't want.

### Testing

Test your skill by running it on a fresh clone before submitting. For source-code changes (the rare ones we accept),
run `npm test` and confirm all tests pass before opening a PR.

### Skill branches and the rebase rule

Skills are distributed as git branches (`skill/<name>`) or as separate remotes for channel skills. **CI rejects skill
branches that contain merge commits from `main`** — branches must be rebased onto current `main` before merging, never
merged directly. See [docs/skills-as-branches.md](docs/skills-as-branches.md) for the full distribution model and the
"Maintaining a Skill Branch" section for the rebase workflow.
