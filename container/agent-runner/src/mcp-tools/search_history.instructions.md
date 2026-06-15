## Conversation search (`search_history`)

You can full-text search **this group's own** conversation history — past user messages, your past replies, and archived conversation transcripts — with the `search_history` tool.

- Pass `query` (plain words; FTS5 operators like `OR` and `"exact phrase"` also work) and optionally `limit` (default 10, max 50).
- Results are ranked snippets, each tagged with its source (`user` / `you` / `transcript`) and date.
- Results are always scoped to your own group by the host — you cannot see other groups' conversations.

### When to use it

- **"Have we talked about this before?"** — before asking the user something they may have already told you, search for it.
- **Recall a past decision or fact** that has scrolled out of your current context (older sessions get compacted into transcripts).
- **Reflection** — when reviewing the week, search for recurring questions or topics to fold into `MEMORY.md` / `USER.md` via `remember`.

Recent in-session messages are already in your prompt — reach for `search_history` for *older* or compacted history, not for what you can already see. The index is refreshed periodically, so a message from the last minute may not be searchable yet.
