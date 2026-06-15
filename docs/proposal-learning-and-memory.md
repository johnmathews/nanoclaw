# Proposal: Learning & Memory Layer

**Status:** proposal (not implemented)
**Date:** 2026-06-12
**Context:** NanoClaw should learn how it is used — what each user asks, which answers land, and what goes wrong when it performs tasks (reports, channel creation, scheduled tasks). This proposal borrows the strongest memory/learning mechanisms from the [Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent) and maps them onto infrastructure NanoClaw already has.

## Where NanoClaw stands today

NanoClaw has a memory **data layer** but no **active layer** — nothing recalls, reflects, consolidates, or records task outcomes unless an agent is explicitly instructed to.

| Exists | Absent |
|--------|--------|
| Per-group `CLAUDE.local.md` (static, never consolidated) | Any automatic memory write/consolidation |
| Transcript archiving to `groups/<folder>/conversations/*.md` via the Claude provider's PreCompact hook | Any way to *search* those transcripts |
| Scheduled tasks with recurrence + retry (`src/host-sweep.ts`) | Persisted failure reasons — on retry-exhaustion the reason is emitted to logs (`host-sweep.ts:298`) but never written to the DB; the task row ends as a bare `status='failed'` |
| Per-group skills mount (`groups/<folder>/skills/`, `src/group-init.ts`) | Any trigger for agents to author/patch their own skills |
| Health snapshot (`src/health-snapshot.ts`) | Per-group usage analytics, answer-usefulness signals |
| Optional `/add-mnemon`, `/add-karpathy-llm-wiki` skills | Anything memory-related shipped by default |

The only automatic learning mechanism in the whole system is transcript archiving.

## What Hermes does (research summary)

Hermes Agent (distinct from the Hermes LLM finetunes) markets itself as "the only agent with a built-in closed learning loop." Its mechanisms:

1. **Curated flat-file memory with hard budgets.** `MEMORY.md` (~2,200 chars, operational lessons) and `USER.md` (~1,375 chars, user preferences) are injected into the system prompt as a frozen per-session snapshot (preserves prompt cache). Written via a `memory` tool with `add` / `replace` / `remove` actions, where `replace`/`remove` match by unique substring, not exact text. **At the budget limit the tool errors and returns current entries**, forcing the agent to consolidate or evict before adding. Explicit "don't store" rules: trivia, searchable facts, code blocks, session ephemera.
2. **Episodic memory = FTS5 over all session history.** Everything in one SQLite DB with FTS5 virtual tables; a `search_messages()` tool keeps weeks-old discussions one query away, which is what lets curated memory stay tiny.
3. **Skills as procedural memory.** On concrete triggers — task took 5+ tool calls and succeeded; agent hit an error and found the fix; user correction revealed a better workflow — the agent writes a `SKILL.md` with mandatory **Pitfalls** and **Verification** sections. When later use proves a skill wrong, the agent patches it in place. Mistakes become procedural docs; stale docs self-heal at point of use.
4. **Cadenced user modeling (Honcho plugin).** Post-hoc LLM analysis of conversations every N turns builds a persistent model of user preferences, style, and goals.
5. **No explicit answer ratings.** Feedback is implicit: corrections become memory entries or skill patches; reflection passes infer what worked.

## Recommendations (ranked by impact-per-effort)

### 1. Budgeted `remember` MCP tool

Add a `remember` tool in `container/agent-runner/src/mcp-tools/` with two targets (`memory` → `MEMORY.md`, `user` → `USER.md`) and three actions (`add`, `replace`-by-substring, `remove`-by-substring), each file under a hard character budget that errors-and-returns-entries at capacity.

The group folder (`/workspace/agent`) is actually mounted **read-write** (`container-runner.ts:273`), so the container *could* write the files directly — but two things make the system-action route the right call anyway. First, the composed `CLAUDE.md` is overlaid **read-only** (`container-runner.ts:291`), so the agent can't edit the live snapshot in place; edits must go to a source file that the host recomposes. Second, NanoClaw's core discipline is "exactly one writer per file" + "everything is a message." So the tool writes a **system action to `outbound.db`** and the host applies the edit and recomposes — same pattern as `schedule`/approvals in `src/delivery.ts`. The justification is single-writer consistency and recomposition, not a missing write permission.

`src/claude-md-compose.ts` injects both files into the composed CLAUDE.md, making them a frozen per-session snapshot (Hermes-style, prompt-cache friendly). Tool description carries the "don't store" rules.

### 2. FTS5 search over conversation history

A host-maintained FTS5 index (new file, e.g. `data/v2-index.db`, or per-group) populated by the sweep from delivered `messages_in`/`messages_out` and the archived `conversations/*.md`, plus a `search_history` MCP tool in the container.

This makes "what did each user ask it" queryable instead of buried, and is what allows the curated memory files in #1 to stay small. The raw material already exists; only the index and tool are new.

### 3. Task outcome log

Two cheap layers:

- **Host side:** when `retryWithBackoff` in `src/host-sweep.ts` exhausts retries, persist the failure reason + timestamp (a `task_outcomes` table in `v2.db`, or append to `groups/<folder>/tasks/outcomes.md`).
- **Agent side:** extend the existing `tasks/<slug>.md` pointer convention with a standing instruction: after each run, append a one-line outcome (succeeded/failed, what went wrong, what to do differently) to `tasks/<slug>.outcomes.md`, and read it first on the next run.

This is the per-task feedback loop and composes with existing recurrence machinery for free.

### 4. Self-authored skills as procedural memory

A container skill (or extension to `self-customize`) teaching Hermes's trigger rules — *5+ tool calls and succeeded*, *error → fix found*, *user correction revealed better workflow* — and a required `SKILL.md` format with **Pitfalls** and **Verification** sections. Per-group skills are not at `groups/<folder>/skills/`; they live at `data/v2-sessions/<group.id>/.claude-shared/skills/`, mounted read-write into the container at `/home/node/.claude/skills/` (`group-init.ts:90`, `container-runner.ts:313`). That directory is per-agent-group and reused across sessions, so a self-authored `SKILL.md` written there persists and is picked up on the next spawn — but note the *existing* entries in it are symlinks into the read-only `/app/skills` source, so agents author **new** files rather than editing symlinked ones in place. Agents patch their own authored skills when usage proves them wrong. Mostly prompt work, not code.

### 5. Weekly reflection as a recurring scheduled task

A recurring per-group task (`tasks/weekly-reflection.md`) that reviews the week's `conversations/`, the task outcomes log, and current `MEMORY.md`/`USER.md`, then consolidates: fold repeated questions into memory, harvest implicit answer-usefulness signals (corrections, follow-ups, Slack reactions), prune stale entries.

This replicates Honcho's cadenced user modeling using NanoClaw's own scheduler instead of a plugin — and is where "which answers are most useful" lives. Explicit thumbs-up/down ratings are deliberately skipped (Hermes skips them too); implicit signals plus a reflection pass are cheaper and less intrusive.

## Deliberately skipped

- **mnemon / external memory providers** — `/add-mnemon` already covers the graph-memory route for those who want it; the five items above get further with less moving machinery (sturdiness priority).
- **Telemetry/analytics dashboard** — real gap, but serves the operator rather than the agent's learning loop. Revisit after #3 exists; the outcome log is the data it would want anyway.

## Build order

`#1` and `#3` are small and independent — build first. `#2` next (enables cheap recall). `#4` is prompt work, anytime. `#5` last — it only pays off once #1–#3 exist to write into.

## Sources

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) · [hermes-agent.org](https://hermes-agent.org/) · [official docs](https://hermes-agent.nousresearch.com/docs)
- [hermes-agent-docs: memory.md](https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/features/memory.md) · [skills.md](https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/features/skills.md) · [honcho.md](https://github.com/mudrii/hermes-agent-docs/blob/main/user-guide/features/honcho.md) · [session-storage.md](https://github.com/mudrii/hermes-agent-docs/blob/main/developer-guide/session-storage.md)
- [Memory OS (community memory stack on Hermes)](https://www.marktechpost.com/2026/06/01/meet-memory-os-a-6-layer-open-source-memory-stack-built-on-top-of-hermes-agent/)
