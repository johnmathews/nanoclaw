# 2026-06-12 — Learning & memory layer proposal (Hermes research)

## What changed

Nothing in the runtime. Added
[docs/proposal-learning-and-memory.md](../docs/proposal-learning-and-memory.md),
a design proposal for making NanoClaw learn from how it's used: what
users ask, which answers land, and what goes wrong when it runs tasks.

## Motivation

NanoClaw has a memory *data layer* (per-group `CLAUDE.local.md`,
workspace files, PreCompact transcript archiving to
`groups/<folder>/conversations/`) but no *active* layer — nothing
recalls, reflects, consolidates, or records task outcomes unless an
agent is explicitly told to. The only automatic learning mechanism in
the entire system is transcript archiving. Scheduled-task failures end
as a bare `status='failed'` with no recorded reason.

## The research

Studied the Nous Research Hermes Agent
(github.com/NousResearch/hermes-agent), whose "closed learning loop" is
built from: hard-budgeted memory files with a capacity-forced
consolidation tool, FTS5 search over all session history as the
episodic tier, agent-authored skills with mandatory Pitfalls +
Verification sections (created on concrete triggers, patched in place
when proven wrong), and cadenced post-hoc user modeling.

## The proposal (5 items, ranked)

1. **Budgeted `remember` MCP tool** — `MEMORY.md` + `USER.md` per group,
   substring-matched edits, errors at capacity. Writes flow as outbound
   system actions (groups mount is RO in the container) — fits
   "everything is a message".
2. **FTS5 index + `search_history` tool** over delivered messages and
   archived conversations.
3. **Task outcome log** — host records failure reasons when retries
   exhaust; agents append per-run outcomes to `tasks/<slug>.outcomes.md`.
4. **Self-authored per-group skills** with Hermes's trigger rules and
   Pitfalls/Verification format (mostly prompt work).
5. **Weekly reflection** as a recurring scheduled task — consolidates
   memory, harvests implicit usefulness signals (corrections,
   reactions). Replaces a Honcho-style plugin with the scheduler we
   already have.

Deliberately skipped: mnemon/external memory providers (covered by
`/add-mnemon` for those who want it) and an analytics dashboard
(operator-facing, revisit after item 3 produces the data).

Build order: 1 and 3 first (small, independent), then 2, then 4/5.
