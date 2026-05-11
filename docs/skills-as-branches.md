# Skills as Branches

NanoClaw skills modify the codebase. Some are distributed as **branches on the upstream repo**, others as **separate
channel repos** added as git remotes. Either way, applying a skill is a `git merge` (or rebase + merge), not a
config setting or a marketplace install.

This doc explains the model. For the day-to-day mechanics of syncing upstream and merging skill branches, see
[runbooks/upstream-sync.md](../runbooks/upstream-sync.md).

## Why branches?

Skills are real code changes, not switches:

- A channel skill like `/add-slack` adds `src/channels/slack.ts`, slack types, env vars, dependencies, and a
  registration import.
- A capability skill like `/add-voice-transcription` adds `src/transcription.ts`, wires it into channel handlers,
  adds env vars, and updates package.json.
- A runtime skill like `/convert-to-apple-container` rewrites `src/container-runtime.ts` and the Dockerfile.

These can't be expressed as feature flags without bloating the codebase. Branches keep the unmodified main lean and
let you compose only the skills you want.

## Two distribution models

### 1. Skill branches on the upstream repo

Most utility skills live as `skill/<name>` branches on `upstream` (`github.com/qwibitai/nanoclaw`):

```
skill/apple-container
skill/compact
skill/emacs
skill/migrate-from-openclaw
skill/migrate-nanoclaw
skill/native-credential-proxy
skill/ollama-tool
skill/qmd
skill/setup-dynamic-context
skill/wiki
... (subject to change — `git branch -r | grep skill/` is authoritative)
```

To install one:

```bash
git fetch upstream
git merge upstream/skill/<name>
npm run build
npm test
```

If `package-lock.json` conflicts, prefer theirs and `npm install` to regenerate.

### 2. Channel skills as separate remotes

Channel skills are their own repos because they ship a lot of files and pull dependencies (baileys for WhatsApp,
@slack/bolt for Slack, etc.). Adding a channel means adding a remote and merging:

| Remote     | Repository                              | Notes                                              |
| ---------- | --------------------------------------- | -------------------------------------------------- |
| `whatsapp` | `github.com/qwibitai/nanoclaw-whatsapp` | Bundled in this fork's `main`; upstream-separated only |
| `slack`    | `github.com/qwibitai/nanoclaw-slack`    | Bundled in this fork's `main`                      |
| `gmail`    | `github.com/qwibitai/nanoclaw-gmail`    | Bundled in this fork's `main`                      |
| `telegram` | `github.com/qwibitai/nanoclaw-telegram` | Bundled in this fork's `main`                      |
| `discord`  | `github.com/qwibitai/nanoclaw-discord`  | Not bundled; install via `/add-discord` skill      |

```bash
git remote add slack https://github.com/qwibitai/nanoclaw-slack.git
git fetch slack main
git merge slack/main
npm run build
```

The slash-command-driven flow does the same thing: `/add-slack`, `/add-whatsapp`, etc. just orchestrate the
git operations and the build. See [fork-divergence.md](fork-divergence.md) for what's bundled in this fork
vs. upstream NanoClaw.

## The Rebase-onto-Main Rule

Always **rebase a skill branch onto current main before merging it**, never merge directly.

```bash
git fetch upstream
git checkout -b apply-skill/foo upstream/skill/foo
git rebase main          # rebase first
git checkout main
git merge --no-ff apply-skill/foo
git branch -d apply-skill/foo
```

**Why this matters:** Skill branches forked from an older main. Their versions of shared files — especially
`src/db.ts` — may be missing columns, fields, or migrations added after the fork point. A direct merge will silently
drop those in conflict resolution. Rebasing surfaces conflicts where they're easier to review (and where the failing
file shows the *skill's* line numbers, not main's).

The CI enforces this:

- **Skill branches with merge commits from main are rejected** — must be rebased.
- **PRs whose schema version is behind main's are blocked** — guards against dropped migrations.

After any skill merge, run `npm test`. The registered-group round-trip tests in `src/db.test.ts` are the most likely
to catch a dropped DB column.

## When a Skill Is "Applied"

A skill is applied when its branch's commits are in your `main` history. There is no separate registry, manifest, or
state file. If you want to know whether a skill is applied:

```bash
git log --oneline --all --grep="skill: <name>"   # if commits use that convention
# or
git log upstream/skill/<name>..HEAD              # commits NOT yet in HEAD (empty = applied)
```

## Removing a Skill

There is no automated "uninstall." Three options:

1. **Revert the merge** — `git revert -m 1 <merge-commit>`. Clean if no other changes have built on top of the skill.
2. **Surgical reverse** — manually remove the channel/feature; usually a small PR.
3. **Reset to a pre-skill point** — destructive; loses commits made after the skill was applied.

Most skills aren't designed to be removed. Plan accordingly.

## Anti-Patterns Avoided

NanoClaw deliberately does **not** use:

- **A skill registry / marketplace** (e.g. `nanoclaw-skills` plugin). Earlier design docs proposed one — abandoned.
  Git is the registry.
- **Manifest files** (`manifest.yaml`, `flavors.yaml`, `.intent.md`). Skills are commits, not declarative bundles.
- **Three-way merge with `rerere`** to cache resolutions. Doesn't pay for itself at this scale; rebase-first
  workflow is simpler.
- **Apply-skill helper scripts.** `scripts/apply-skill.ts` was removed in favor of plain git.

If a skill ever genuinely needs a manifest, write it then. Don't pre-build the framework.

## Related Documents

- [runbooks/upstream-sync.md](../runbooks/upstream-sync.md) — concrete cherry-pick and merge procedures with conflict patterns
- [`/update-nanoclaw` skill](../.claude/skills/update-nanoclaw/SKILL.md) — guided update flow
- [REQUIREMENTS.md §Skills Over Features](REQUIREMENTS.md#skills-over-features) — philosophy
- [CLAUDE.md "Merging Skill Branches"](../CLAUDE.md#merging-skill-branches) — operational rules
