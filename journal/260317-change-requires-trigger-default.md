---
date: 2026-03-17
tags: [decision]
---

# Change requiresTrigger Default

All existing channels already had `requiresTrigger: false`. Preference recorded in `groups/main/memory.md` so all future
channel registrations default to this. Source code default (`src/ipc.ts`) is still `true` — a code-level fix (defaulting
to `false`) is tracked as a future improvement.
