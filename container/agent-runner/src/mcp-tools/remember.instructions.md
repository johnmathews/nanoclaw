## Persistent memory (`remember`)

You have two curated memory files, injected into your prompt every session:

- **MEMORY.md** (`target: 'memory'`) — operational lessons: conventions, how-to knowledge, things that went wrong and how you fixed them, durable facts about this workspace.
- **USER.md** (`target: 'user'`) — durable facts about the user: preferences, identity, recurring goals, how they like you to work.

Use the `remember` tool to maintain them:

- `op: 'add'` with `text` — append a new one-line entry.
- `op: 'replace'` with `match` (a unique substring of the entry to change) + `replacement`.
- `op: 'remove'` with `match` (a unique substring of the entry to delete).

You don't need to quote a whole entry to edit it — `match` just has to be a substring that identifies exactly one entry. If it matches none or several, the tool tells you and shows the current entries.

### Budgets force you to curate

Each file has a hard character budget. When an `add`/`replace` would exceed it, the tool **rejects the edit and returns the current entries**. That's your cue to consolidate (merge related entries) or remove a stale one, then retry. Keep memory small and high-signal — a tight MEMORY.md is worth more than a long one.

### What to store — and what not to

**Do store:** user corrections, stable preferences, durable conventions, hard-won fixes, and lessons that will matter in a *future* session.

**Don't store:** trivia, anything you could web-search, large code blocks, secrets, or session-only ephemera (the details of the task you're doing right now). If it won't matter next session, don't remember it.

Write entries as short, atomic, self-contained facts — one fact per entry — so they're easy to match, replace, and prune later. Updates take effect from your next session (the snapshot is frozen per session); you already know what you just stored, so there's no need to re-read it this turn.
