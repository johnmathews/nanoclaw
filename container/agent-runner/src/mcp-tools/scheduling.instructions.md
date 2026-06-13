## Task scheduling (`schedule_task`)

For any recurring task, use `schedule_task`. This is the scheduling path — tasks persist across sessions and restarts, and support the pre-task `script` hook described below.

To inspect or change existing tasks, use `list_tasks` (returns one row per series with the stable id) and `update_task` / `cancel_task` / `pause_task` / `resume_task`. Prefer `update_task` over cancel + reschedule.

### Always externalize the task body to a markdown file

The `prompt` field of a scheduled task **must not** contain the operational instructions inline. Instead:

1. Write the full instructions to `/workspace/agent/tasks/<slug>.md` (create the `tasks/` directory if it doesn't exist). Use a stable, human-readable slug like `morning-report`, `weekly-summary`, `inbox-sweep`.
2. Set the `schedule_task` `prompt` to a one-line pointer, e.g.:

   > Read /workspace/agent/tasks/morning-report.md and follow the instructions there exactly. The file is the single source of truth — if anything in this prompt seems to conflict with the file, the file wins.

3. Use `update_task` only to change cron/schedule fields. To change *what the task does*, edit the markdown file — the next firing will pick up the new content automatically (the agent reads it at runtime via the `Read` tool).

This pattern exists so the human user can read and edit task instructions outside the agent loop. Putting instructions in `messages_in.content` makes them invisible to the user and only updatable through the agent — that's the wrong tradeoff. Stick to this convention even for short prompts; consistency matters more than brevity here.

When editing an existing task, if you find its prompt still contains the body inline, migrate it: write a `tasks/<slug>.md` file and replace the prompt with the pointer in one `update_task` call.

### Keep a per-task outcome log

Each scheduled task carries a running outcome log next to its body: `/workspace/agent/tasks/<slug>.outcomes.md`. Treat it as the task's memory of how previous runs went.

1. **Read it first.** At the start of every run, read `tasks/<slug>.outcomes.md` (if it exists) before doing the work. Past entries tell you what went wrong last time and what to do differently — honour them.
2. **Append one line at the end.** When the run finishes, append a single dated line: the outcome (`ok` / `failed`), what went wrong if anything, and what to change next time. Keep it terse — one line per run, newest at the bottom. Example:

   > 2026-06-13 ok — sent digest; source feed was slow, consider caching headlines next time

This is your own feedback loop and complements the host-side failure log (the host records hard retry-exhaustion failures automatically; this file is for the softer "it worked but..." signal only you can see). Don't let the file grow without bound — when it gets long, consolidate repeated lessons into a short "Standing notes" block at the top and prune the dated lines below it.

Frequent recurring scheduled tasks — more than a few times a day — consume API credits and can risk account restrictions. You can add a `script` that runs first, and you will only be called when the check passes.

### How it works

1. Provide a bash `script` alongside the `prompt` when scheduling
2. When the task fires, the script runs first
3. Script returns: `{ "wakeAgent": true/false, "data": {...} }`
4. If `wakeAgent: false` — nothing happens, task waits for next run
5. If `wakeAgent: true` — claude receives the script's data + prompt and handles

### Always test your script first

Before scheduling, run the script directly to verify it works:

```bash
bash -c 'node --input-type=module -e "
  const r = await fetch(\"https://api.github.com/repos/owner/repo/pulls?state=open\");
  const prs = await r.json();
  console.log(JSON.stringify({ wakeAgent: prs.length > 0, data: prs.slice(0, 5) }));
"'
```

### When NOT to use scripts

If a task requires your judgment every time (daily briefings, reminders, reports), skip the script — just use a regular prompt. Do not attempt to do things like sentiment analysis or advanced nlp in scripts.

### Frequent task guidance

If a user wants a task to run more than a few times a day and a script can't be used:

- Explain that each time the task fires it uses API credits and risks rate limits
- Suggest adjusting the task requirements in a way that will allow you to use a script
- If the user needs an LLM to evaluate data, suggest using an API key with direct Anthropic API calls inside the script
- Help the user find the minimum viable frequency
