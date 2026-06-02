---
tags: [fix]
date: 2026-06-02
---

# `<internal>` scratchpad tags still leaking to channels — two paths the e30f4a8 fix missed

## Symptom

`#main-group` on Slack kept showing raw scratchpad messages from the morning-report
agent, e.g.:

```
<internal>June 2 morning report sent (ID 19e86d2e73fe7098). No failures — no Slack message needed per task rules.</internal>
```

One per day, dated through June 1 and June 2 — i.e. *after* `e30f4a8`
("strip `<internal>` tags from send_message/send_file bodies") had shipped and was
live in spawned containers.

## Root cause

The contract is: text wrapped in `<internal>...</internal>` is scratchpad — logged
but never delivered. `e30f4a8` enforced that on the `send_message` / `send_file` MCP
tools, but two other paths that put agent-authored prose on a channel were never
covered:

1. **Result-text `<message>` body** (`dispatchResultText` in `poll-loop.ts`).
   The agent's final output must be wrapped in `<message to="...">...</message>`
   blocks. That parser stripped `<internal>` only from *scratchpad* (text outside
   blocks). The morning-report agent wraps its note **inside** a block —
   `<message to="main"><internal>report sent…</internal></message>` — and the body
   was taken as `match[2].trim()` with no stripping, so the raw tags went straight
   to Slack. This is the path that produced the visible leak (confirmed by reading
   the `kind:'chat'` rows in the main session's `outbound.db`).

2. **`edit_message`** (`core.ts`). The exact parallel of `send_message` — agent
   passes free-text `text` that becomes the channel message — but `e30f4a8` only
   touched `send_message`/`send_file`. Not the source of the observed leak, but the
   same latent bug.

`e30f4a8`'s own code comment even claimed it matched "the same way the final
result-text path does" — but that path didn't actually strip inside `<message>`
bodies, so the comment described a guarantee that didn't exist.

## Fix

Both paths now run the body through the shared `stripInternalTags` helper, and send
nothing when the body is entirely internal:

- `dispatchResultText`: strip each `<message>` body; if empty after stripping,
  `continue` (no outbound row, not counted as sent — so an all-internal final
  output correctly produces no warning and no message).
- `edit_message`: strip the new body; if empty, skip the edit and report back
  rather than blanking the existing message.

Updated `core.instructions.md` so the agent-facing doc now states the guarantee
applies everywhere a body is delivered — bare final text, inside `<message>` blocks,
and `send_message` / `send_file` / `edit_message`.

## Audit — every other outbound path

Traced all `writeMessageOut` callers in the agent-runner to confirm these were the
only gaps:

| Path | Carries agent prose? | Status |
|------|----------------------|--------|
| result-text `<message>` body (`poll-loop`) | yes | fixed here |
| `send_message` / `send_file` (`core.ts`) | yes | fixed in `e30f4a8` |
| `edit_message` (`core.ts`) | yes | fixed here |
| `add_reaction` | emoji only | safe |
| `create_agent` (`agents.ts`) | `kind:system`, CLAUDE.md content | safe |
| `scheduling.ts` (×5) | `kind:system` structured actions | safe |
| `self-mod.ts` (×2) | `kind:system` structured actions | safe |
| `interactive.ts` (×3) | `kind:chat-sdk` structured card fields | low-risk, left as-is |
| `poll-loop` "Session cleared." / "Error: …" | fixed literals | safe |

## Deliberately not changed

1. **`interactive.ts` cards** (`ask_question` title/question/options, card/blocks
   `fallbackText`) — structured `chat-sdk` UI fields the agent fills deliberately,
   not prose dumps. Low leak risk; stripping arbitrary card JSON would be invasive.
2. **`stripInternalTags` regex** (`/<internal>[\s\S]*?<\/internal>/g`) — case-
   sensitive and requires a closing tag, so `<INTERNAL>` or an unclosed `<internal>`
   would still leak. This limitation is shared by *all* paths (including the
   already-shipped fix), so widening it is a separate, broader decision rather than
   part of this bug.

## Gotchas / notes

- **No rebuild needed.** The agent-runner `src/` is bind-mounted RO and picked up
  on the next container spawn. The morning-report task spawns a fresh session each
  run, so the next run gets the fix; the leak stops then on its own.
- **The 6 already-posted Slack messages remain.** The available Slack tooling is
  read/send/react only — no delete — so they can't be removed programmatically.
- The agent's underlying *habit* (wrapping a "report sent" confirmation in a
  `<message>` block at all) is a separate, milder issue — `core.instructions.md`
  already tells it to just send nothing instead of posting a confirmation.

## Tests

Four regression tests added:

- `integration.test.ts`: `<internal>` inside a `<message>` block is stripped from
  the delivered body; an entirely-internal block queues nothing.
- `core.test.ts`: `edit_message` strips `<internal>` from the new body; an
  entirely-internal edit is skipped.

Full container suite: 133 pass.
