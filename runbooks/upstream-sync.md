# Upstream Sync

This is a fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). We cherry-pick useful changes rather than
merging — the fork has custom features (migration system, extra MCP servers, channel-specific configs) that would
conflict with a full merge.

## Repository Remotes

| Remote     | Repository                              | Purpose               |
| ---------- | --------------------------------------- | --------------------- |
| `origin`   | `github.com/johnmathews/nanoclaw`       | Our fork              |
| `upstream` | `github.com/qwibitai/nanoclaw`          | Original project      |
| `whatsapp` | `github.com/qwibitai/nanoclaw-whatsapp` | WhatsApp channel fork |
| `gmail`    | `github.com/qwibitai/nanoclaw-gmail`    | Gmail channel fork    |
| `slack`    | `github.com/qwibitai/nanoclaw-slack`    | Slack channel fork    |

## Checking for Upstream Changes

```bash
# Fetch all remotes
git fetch --all --prune

# List upstream commits not in our fork
git log --oneline upstream/main ^origin/main

# Count them
git log --oneline upstream/main ^origin/main | wc -l

# See what changed in a specific commit
git show --stat <hash>
git show <hash>
```

## Cherry-Pick Workflow

**Why cherry-pick instead of merge?** Our fork has a proper migration system in `src/db.ts` (versioned, idempotent
migrations). Upstream uses inline `ALTER TABLE` statements. A merge would silently drop our migration framework during
conflict resolution. Cherry-picking lets us take individual changes and adapt them to our codebase.

### Steps

```bash
# 1. Fetch latest upstream
git fetch upstream

# 2. Review the commit
git show <hash>

# 3. Cherry-pick without committing (so you can inspect/fix conflicts)
git cherry-pick <hash> --no-commit

# 4. If there are conflicts, resolve them
#    Key pattern: keep our fork's code, add the new feature
git status                    # See conflicted files
# Edit files to resolve conflicts
git add <resolved-files>

# 5. Commit with clear provenance
git commit -m "feat: description of change

Cherry-pick of upstream <hash>. Brief note about any conflict resolution.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"

# 6. Run tests
NODE_OPTIONS="--max-old-space-size=1536" npm test

# 7. Push
git push origin main
```

### Common Conflict Patterns

**`src/db.ts`** — Most common. Upstream uses inline ALTER TABLE; we use versioned migrations. Resolution: add the new
columns/tables as a new migration entry in our `migrations` array instead of using upstream's inline approach.

**`src/index.ts`** — Import differences. Our fork has additional imports (health, watchdog, host-commands,
session-commands). Resolution: keep our imports, add any new ones from upstream.

**`container/agent-runner/src/index.ts`** — MCP server configs. Our fork has additional MCP servers (docs, journal,
parallel-search). Resolution: keep our MCP configs, add upstream's new features.

**`package.json` / `package-lock.json`** — Dependency trees diverge. Resolution: often simpler to abort the cherry-pick
and run the equivalent npm command directly (e.g., `npm audit fix`, `npm uninstall <pkg>`).

### What to Skip

- **Version bumps** (`chore: bump version to X.Y.Z`) — our version is independent
- **Token count updates** — auto-generated, our CI does this
- **Prettier/eslint bulk reformats** — creates conflicts on every future cherry-pick
- **OneCLI / credential proxy features** — we don't use OneCLI
- **Apple Container / macOS features** — we're on Linux
- **Merge commits** — never cherry-pick these; take the feature commit directly

## Automated Git Maintenance

A Slack bot in `#git-maintenance` runs a scheduled report (Monday and Thursday at 4am Amsterdam time) that:

1. Fetches all remotes
2. Analyzes local branches for cleanup
3. Compares upstream/main vs origin/main
4. Posts an interactive Block Kit report with recommendations
5. Waits for human confirmation before acting

The report includes an **Advice** section prioritizing which upstream changes to cherry-pick.

Configuration: `groups/slack_git-maintenance/CLAUDE.md`

## CI Workflows

Our fork runs these GitHub Actions on push:

| Workflow                     | Purpose                                  |
| ---------------------------- | ---------------------------------------- |
| CI                           | Runs tests                               |
| Update token count           | Auto-commits token count badge           |
| Bump version                 | Auto-commits version bump                |
| Merge-forward skill branches | Fast-forwards skill/\* branches          |
| Sync upstream                | Fetches upstream changes (doesn't merge) |

The token count and version bump workflows create auto-commits after your push. Pull before pushing again to avoid
conflicts:

```bash
git pull --rebase origin main
```

## Fork Version

Our fork version is independent of upstream. Check with:

```bash
node -e "console.log(require('./package.json').version)"
```
