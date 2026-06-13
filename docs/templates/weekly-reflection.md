<!--
  SEED TEMPLATE — weekly reflection (Learning & Memory Layer, Feature 5).

  To enable for a group, copy this file to that group's task dir and wire a
  recurring task that POINTS at it (never inline the body):

      cp docs/templates/weekly-reflection.md groups/<folder>/tasks/weekly-reflection.md

  Then, from inside the group's agent, schedule it (or wire via ncl):
      schedule_task({ prompt: "Run task: tasks/weekly-reflection.md",
                      recurrence: "0 9 * * 1" })   # Mondays 09:00

  The task row stores only the one-line pointer; this file is the body and
  evolves under git. Composes with the rest of the layer: search_history
  (Feature 2), tasks/*.outcomes.md (Feature 3), and remember (Feature 1).
-->

You are running your **weekly reflection**. The goal is to consolidate what you learned this week into durable memory so future sessions start smarter — and to prune what has gone stale. This is maintenance of your own memory, not a user-facing report.

**Do NOT send any chat message or email. Produce no output outside tool calls.** Reflection is silent; the only side effects are memory edits and (optionally) authored skills.

## Step 1 — Gather the week's signal

1. **Recent conversations.** List `/workspace/agent/conversations/` and read the transcripts from the last 7 days. Note recurring questions, repeated corrections, and decisions that should outlive the session.
2. **Search history for patterns.** Use the `search_history` tool for the questions/topics that came up more than once this week (e.g. `search_history({ query: "<topic>" })`). You are looking for: things the user asks repeatedly (→ candidates for memory), and answers you had to reconstruct from scratch that you could have recalled.
3. **Task outcomes.** Read every `/workspace/agent/tasks/*.outcomes.md` file. These record what failed and what to change. Identify any failure that recurred, or a fix you discovered that isn't yet captured anywhere durable.

## Step 2 — Consolidate into memory

Using the `remember` tool, fold this week's learnings into your persistent memory. Two targets:

- `target: "user"` (USER.md) — durable facts about the user: a stated preference, a goal, an identity detail, a "always/never do X" correction.
- `target: "memory"` (MEMORY.md) — operational lessons and conventions: a workflow that worked, a gotcha and its fix, a recurring-question answer worth keeping.

Rules:

- **Fold repeats in, don't duplicate.** If something this week reinforces an existing entry, use `op: "replace"` (with a `match` substring) to sharpen it — don't add a near-duplicate. Add a genuinely new entry with `op: "add"`.
- **Prune stale entries.** If an entry is now wrong, obsolete, or superseded by this week's events, `op: "remove"` it. Reflection is the moment to garbage-collect.
- **Keep entries short and atomic** — one fact per entry. Store corrections, preferences, durable conventions, and lessons that will matter next session. Do NOT store trivia, web-searchable facts, large code blocks, or session-only ephemera.
- If an `add`/`replace` is rejected for exceeding the budget, the tool returns the current entries — consolidate or remove first, then retry. Treat a full budget as a signal to prune, not to ask for more space.

## Step 3 — Procedural memory (optional)

If this week surfaced a multi-step procedure worth keeping (a working deploy/setup/scrape recipe, an error→fix you'll hit again), author it as a skill following the **learn-skill** guidance: a uniquely-named new directory under `/home/node/.claude/skills/<name>/SKILL.md` with the required `## Pitfalls` and `## Verification` sections. Never edit a shared (symlinked) skill in place.

## Step 4 — Finish silently

When done, stop. No summary message, no email, no chat. The work product is the updated `MEMORY.md` / `USER.md` (and any authored skill) — nothing else.
