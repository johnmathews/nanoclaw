# 2026-05-28 — Make the CLAUDE.md skill-selection TODO discoverable

## What changed

Nothing in the runtime. This entry exists to surface a long-standing
inconsistency in how `container_configs.skills` is read, and to point at
the path forward.

- Expanded the inline comment at `src/claude-md-compose.ts:64-65`.
- Opened GitHub issue
  [#731](https://github.com/johnmathews/nanoclaw/issues/731) capturing the
  spec.

## The inconsistency

`container_configs.skills` is typed `string[] | 'all'`. Two systems read
it:

1. **Slash-command skill registry**, written into
   `/home/node/.claude/skills/` by `syncSkillSymlinks` in
   `src/container-runner.ts:342-365`. **Respects the field.** If
   `skills === ['onecli-gateway']`, only that slash command is reachable.
2. **CLAUDE.md instruction fragments**, written into
   `.claude-fragments/skill-*.md` by `composeGroupClaudeMd` in
   `src/claude-md-compose.ts:64-77`. **Ignores the field.** Every skill
   with an `instructions.md` is wired into every agent's prompt.

Same column, two readers, two defaults. (1) was always intended to be
per-group; (2) was deferred ("TODO shared-source refactor") and the work
never landed.

## Why this came up now

The `reporting` skill (added 2026-05-28) extracts shared report-style
rules out of three channels' `CLAUDE.local.md` files into a single
`container/skills/reporting/instructions.md`. Auto-discovery means it now
lands in every agent's CLAUDE.md — including ~6 of 11 groups that don't
produce structured reports. The fragment is self-gating ("use this when
producing a structured report"), so cost today is just ~1.5–2K
unnecessary system-prompt tokens per turn for those groups. Acceptable,
but the right long-term answer is for those groups to set
`skills: ['onecli-gateway', 'whatsapp-formatting']` and have the
reporting fragment naturally excluded.

That's exactly the change the TODO has been asking for. It's never been
written down anywhere a future reader would find it before bumping into
the comment.

## Why it hasn't shipped

No idea — the TODO predates the journal. Best guess: the (1) system was
written first, the field was extended for it, and (2) was a "we'll get to
this once we have a use case" deferral. The reporting skill is the first
use case where universal inclusion is visibly wasteful. Before
`reporting`, every skill that existed was framed conditionally enough
that being included everywhere didn't hurt.

## What the work looks like (per #731)

In `claude-md-compose.ts`, after the skill discovery loop builds
`desired`, filter against `configRow.skills`:

- `'all'` → no change (current default)
- `string[]` → drop entries whose skill name isn't in the array

Module fragments (`module-*.md`, lines 84-96) stay unfiltered — they're
built-in tooling instructions, not user-selectable skills. The MCP-server
loop at line 100 is the precedent: it already only emits fragments for
servers declared in `container.json`.

Default new groups to `'all'` so existing behaviour is unchanged. Opt-in
by exception via `ncl groups config update --skills …`.

## What this entry is *not*

- Not a decision to ship the change now. The current auto-include is
  workable; this is queued, not urgent.
- Not a spec — the spec lives in #731. This is the "why does the comment
  point at an issue, and why did we bother filing it" pointer.

## References

- TODO comment: `src/claude-md-compose.ts:64-72`
- Existing per-group reader: `src/container-runner.ts:342-365`
  (`syncSkillSymlinks`)
- Existing opt-in precedent in the same file: MCP-server fragment loop,
  `src/claude-md-compose.ts:100-107`
- The skill that surfaced this: `container/skills/reporting/instructions.md`
