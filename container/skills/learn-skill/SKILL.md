---
name: learn-skill
description: Turn a hard-won procedure into a reusable skill (procedural memory). Use after you work out a multi-step workflow that succeeded, fix a non-obvious error once you find the cause, or a user correction reveals a better way to do something — so next time you (or a sibling session) start from the solution instead of rediscovering it.
---

# Authoring Skills as Procedural Memory

Some things are worth remembering as a *procedure*, not a fact. When you've just figured out how to do something the hard way, write it down as a skill so the next session starts from the answer. This is your procedural memory — the counterpart to `remember` (which stores facts in `MEMORY.md`/`USER.md`).

A skill you author is a directory under `/home/node/.claude/skills/<name>/` containing a single `SKILL.md`. It is persisted on the host and re-discovered on every future spawn — no approval, no restart, no code change.

## When to author a skill (the three triggers)

Author a skill when **one** of these happens. Don't author for one-off trivia — that's what `remember` is for.

1. **A multi-step procedure succeeded.** You ran roughly 5 or more tool calls to accomplish something (a deploy, a data migration, a multi-command setup, a scraping recipe) and it worked. Capture the working sequence before you lose it.
2. **An error → you found the fix.** You hit a non-obvious failure (a cryptic error, an auth quirk, a config gotcha) and worked out the cause and the remedy. Capture the symptom *and* the fix so you recognise it instantly next time.
3. **A user correction revealed a better workflow.** The user told you "no, do it this way" and that way is genuinely better. Capture the corrected workflow — this is the highest-signal trigger; the user just paid to teach you.

## The one hard rule: author a uniquely-named NEW directory

Skills shared by all agents (`agent-browser`, `status`, `welcome`, …) are **symlinks** into a read-only mount. The host reconciles those symlinks on every spawn.

- ✅ **DO** create a brand-new directory under a name that does not collide with any shared skill: `/home/node/.claude/skills/deploy-vercel-static-site/SKILL.md`. A real (non-symlink) directory with a unique name survives every future spawn untouched.
- ❌ **NEVER** edit a shared skill in place. The shared skills are symlinks to a read-only source; your edits won't stick, and worse — **a directory whose name collides with a shared skill is deleted on the next spawn.** If you author `status/` or `welcome/`, it will be wiped.

Pick a specific, hyphenated name describing the procedure (`reset-prod-cache`, `scrape-paywalled-article`), not a generic one (`helper`, `notes`). Before writing, glance at the existing skills so you don't collide.

## Required structure of an authored skill

Every skill you write MUST contain these two sections, because a procedure you can't verify and whose traps you don't flag is a liability, not a memory:

- **`## Pitfalls`** — the non-obvious traps: what looks right but fails, the error you actually hit, the ordering that matters, the thing that silently no-ops.
- **`## Verification`** — how to confirm the procedure actually worked: the command to run, the output to expect, the state to check. Never declare success on "no error thrown" alone.

Skeleton:

```markdown
---
name: <unique-hyphenated-name>
description: <one line — what this does and when to reach for it, so future-you matches on it>
---

# <Title>

<One paragraph: what problem this solves and the context it applies in.>

## Steps

1. <concrete command or action>
2. ...

## Pitfalls

- <the trap that cost you time this session>

## Verification

- <how to know it worked — a command + expected output>
```

## Patch on disproof

A skill is a hypothesis about what works. When a future run shows a step is wrong, stale, or incomplete — **edit your own authored skill in place** (it's a real file you own, unlike the shared symlinks) to correct it, or add the new pitfall you just discovered. Don't let a known-wrong procedure sit there misleading the next session. If a skill turns out to be entirely obsolete, delete its directory.

## Pitfalls

- **Colliding with a shared skill name deletes your work.** The host's spawn-time reconciliation `rmSync`s any directory whose name matches a shared/desired skill. Always pick a unique name; check the existing skill list first.
- **Editing a symlinked shared skill does nothing useful.** Those targets are read-only and reset each spawn. Author a new directory instead.
- **Skipping Pitfalls/Verification.** A procedure with no verification step will eventually report a silent failure as success. Both sections are required.
- **Over-authoring.** A single fact ("the prod DB is at host X") belongs in `remember`, not a skill. Skills are for *procedures* — sequences of actions.

## Verification

- After writing, confirm the file exists and is a real directory (not a symlink):
  `ls -la /home/node/.claude/skills/<name>/SKILL.md`
- Confirm the frontmatter parses: the file starts with a `---` block containing `name:` and `description:`.
- Confirm your `## Pitfalls` and `## Verification` headers are present.
- The skill becomes available to future sessions on the next container spawn; it will appear in the skills list by its `description`.
