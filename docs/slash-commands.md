# Slash Commands

Reference for every slash command the agent understands and how the orchestrator decides where each one runs.

**Source of truth:** [`src/session-commands.ts`](../src/session-commands.ts). Host implementations live in
[`src/host-commands.ts`](../src/host-commands.ts); agent-runner implementations live in
[`container/agent-runner/src/index.ts`](../container/agent-runner/src/index.ts) and
[`container/agent-runner/src/utils.ts`](../container/agent-runner/src/utils.ts).

This document reconciles the README and `CLAUDE.md` against the actual code. If anything here disagrees with the
source files, the source files win — patch this doc, not the code.

---

## 1. The Three Categories

Every `/<command>` falls into exactly one of three handling paths.

### 1.1 Host-intercepted

Handled on the host before any container is spawned. The host runs the command inline in the message loop, sends the
response to the channel, advances the cursor, and never wakes the agent. The set is declared in
[`src/session-commands.ts:5`](../src/session-commands.ts) and routed through
`executeHostCommand()` in [`src/host-commands.ts:315`](../src/host-commands.ts).

```typescript
const INTERCEPTED_COMMANDS = new Set(['/usage', '/status']);
```

The message loop branch that performs this dispatch is
[`src/index.ts:756-791`](../src/index.ts) — note that intercepted commands execute inline and the cursor is advanced
in the same tick so the command message cannot be re-piped on the next poll.

### 1.2 Agent-runner-intercepted

Handled inside the container by the agent-runner *before* the Claude Agent SDK query starts. These commands either
have no SDK equivalent or the SDK's built-in version sets `supportsNonInteractive=false`, so the agent-runner does
the work directly and writes the response on stdout. See
[`container/agent-runner/src/index.ts:649-677`](../container/agent-runner/src/index.ts).

The two commands handled this way are `/skills` and `/clear`. A third command, `/model`, runs an SDK query but the
agent-runner intercepts the SDK's *result* and substitutes the real model name pulled from the init message
([`container/agent-runner/src/index.ts:710-758`](../container/agent-runner/src/index.ts)).

### 1.3 SDK-forwarded

Every other single-word `/<command>` is forwarded to the SDK as the literal prompt. The SDK runs its internal slash
command machinery and emits a `result` message which the agent-runner relays back. The dispatch loop is
[`container/agent-runner/src/index.ts:687-799`](../container/agent-runner/src/index.ts) and the host-side enqueue
that triggers it is [`src/index.ts:793-811`](../src/index.ts).

`/compact` and `/done` go down this path. Any other single-word command the SDK recognises will also work; if the
SDK does not recognise it the response includes an "Available commands" list built from the SDK's init message via
`formatSlashCommandError()` ([`container/agent-runner/src/utils.ts:76`](../container/agent-runner/src/utils.ts)).

## 2. Auth Model

Two authorisation tiers, declared in [`src/session-commands.ts:5-8`](../src/session-commands.ts) and enforced by
`isSessionCommandAllowed()` at [`src/session-commands.ts:45-51`](../src/session-commands.ts):

- **Read-only commands** — `/usage`, `/status`, `/model`, `/skills`. Available to any sender who can already talk
  to the agent. They bypass the admin check entirely.
- **Admin (session-modifying) commands** — `/compact`, `/clear`, `/done`, plus any other SDK-forwarded command.
  Allowed only if `isMainGroup || isFromMe || !requiresTrigger`. The last clause means direct-conversation groups
  (where every sender is already implicitly trusted to wake the agent) are also trusted to manage its session.

Both the message-loop gate at [`src/index.ts:797-806`](../src/index.ts) and `handleSessionCommand()` at
[`src/session-commands.ts:119-132`](../src/session-commands.ts) apply the same rule. They must stay in sync —
read-only commands have to skip the gate in both places, otherwise `/skills` and `/model` would silently fail in
non-admin groups.

Unauthorised admin commands get a one-line "Session commands require admin access." reply
([`src/session-commands.ts:128`](../src/session-commands.ts)) and the cursor advances past the command.

## 3. Command Reference

| Command    | Category            | Auth      | What it does                                                       | Implementation                                                                                                  |
| ---------- | ------------------- | --------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `/usage`   | Host-intercepted    | Read-only | Reports plan utilisation (5-hour / 7-day / per-model) and resets.  | [`src/host-commands.ts:328-339`](../src/host-commands.ts)                                                       |
| `/status`  | Host-intercepted    | Read-only | Reports service health (uptime, channels, queue, cursor lag).      | [`src/host-commands.ts:316-327`](../src/host-commands.ts)                                                       |
| `/skills`  | Agent-runner        | Read-only | Lists installed skills + known built-in commands.                  | [`container/agent-runner/src/index.ts:655-663`](../container/agent-runner/src/index.ts)                         |
| `/clear`   | Agent-runner        | Admin     | Deletes the SDK session file so the next query starts fresh.       | [`container/agent-runner/src/index.ts:667-677`](../container/agent-runner/src/index.ts)                         |
| `/model`   | Agent-runner hybrid | Read-only | Reports the resolved model name (pulled from the SDK init event). | [`container/agent-runner/src/index.ts:710-758`](../container/agent-runner/src/index.ts)                         |
| `/compact` | SDK-forwarded       | Admin     | Asks the SDK to summarise and shrink the conversation in place.    | SDK built-in, dispatched via [`container/agent-runner/src/index.ts:687-799`](../container/agent-runner/src/index.ts) |
| `/done`    | SDK-forwarded       | Admin     | Forwarded to the SDK as-is; behaviour depends on the SDK version. | SDK built-in, same dispatch path as `/compact`                                                                  |

Any other single-word `/<command>` is also passed through to the SDK and treated as admin
([`src/session-commands.ts:118-132`](../src/session-commands.ts)).

## 4. Per-Command Notes

### `/usage`

Tries the `api.anthropic.com/api/oauth/usage` endpoint first (`src/host-commands.ts:230`) using the OAuth token from
`~/.claude/.credentials.json`, refreshing the access token via `console.anthropic.com/v1/oauth/token`
(`src/host-commands.ts:92`) if it is expired or within the 5-minute pre-expiry buffer
([`src/host-commands.ts:172-209`](../src/host-commands.ts)). On success it renders progress bars for the 5-hour
session, 7-day window, per-model windows, and any extra credits
([`src/host-commands.ts:250-272`](../src/host-commands.ts)). On failure it returns an actionable error indicating
whether credentials are missing, the token is expired, or the API errored
([`src/host-commands.ts:274-303`](../src/host-commands.ts)).

### `/status`

Calls the registered health provider (set during orchestrator startup via `registerHealthProvider()`,
[`src/host-commands.ts:309`](../src/host-commands.ts)) and renders the result with `formatHealthText()`. If the
provider has not been registered yet the command returns a one-line "health provider not initialized" message
rather than throwing ([`src/host-commands.ts:316-326`](../src/host-commands.ts)).

### `/skills`

Lists the union of built-in SDK commands (`/clear`, `/compact`, `/done`), host commands (`/usage`), and any
directory under `~/.claude/skills/` inside the container. The merge happens in
[`container/agent-runner/src/utils.ts:103-111`](../container/agent-runner/src/utils.ts). Because the agent-runner
returns synchronously without invoking the SDK, this command is cheap and safe to run while another conversation is
active.

### `/clear`

The Claude Agent SDK ships a `/clear` of its own, but it has `supportsNonInteractive=false` and cannot be driven
over the agent-runner's stdin protocol. The agent-runner therefore handles `/clear` itself by deleting the session
`.jsonl` file via `clearSessionFile()` ([`container/agent-runner/src/utils.ts:116-127`](../container/agent-runner/src/utils.ts))
and returning `newSessionId: ''`. The host treats the empty-string session id as a deletion signal and removes
its in-memory tracking entry. There is also a host-side safety net at session resume time that auto-clears any
session larger than 10MB to prevent prompt-too-long deadlocks (see `CLAUDE.md` "Session Management").

### `/model`

Runs an SDK query with an empty `allowedTools` list and inspects the init event for the `model` field
([`container/agent-runner/src/index.ts:710-714`](../container/agent-runner/src/index.ts)). When the SDK reports
"Unknown skill" (it does not have a built-in `/model` handler), the agent-runner replaces the result text with
`*Model:* <name>` ([`container/agent-runner/src/index.ts:754-759`](../container/agent-runner/src/index.ts)). The
underlying value is whatever the host passed via `ANTHROPIC_MODEL`, resolved per-group in `src/group-config.ts`.

### `/compact`

Forwarded to the SDK, which summarises the conversation and replaces the session content with the summary. Before
compaction the agent-runner's `PreCompact` hook archives the full transcript to
`groups/{name}/conversations/<date>-<summary>.md`
([`container/agent-runner/src/index.ts:165-205`](../container/agent-runner/src/index.ts)) so the original
exchange is preserved on disk even though the SDK has dropped it from the active context.

### `/done`

Passed through to the SDK with no special handling on either the host or the agent-runner side. There is no
`case '/done'` branch in [`container/agent-runner/src/index.ts`](../container/agent-runner/src/index.ts) — the
command is recognised as a single-word `/<command>` by the regex at line 647 and falls into the generic forward
path. Whether the SDK does anything useful with it depends on the SDK version; recent versions treat it as a
session-end signal. Listed in `SDK_COMMANDS` at
[`container/agent-runner/src/utils.ts:83`](../container/agent-runner/src/utils.ts) so it appears in `/skills`
output.

## 5. Backslash Normalisation

`extractCommand()` accepts both `/command` and `\command`
([`src/session-commands.ts:15-24`](../src/session-commands.ts)):

```typescript
const match = text.match(/^[/\\](\w+)$/);
if (!match) return null;
return '/' + match[1];
```

This exists because Slack intercepts `/` as a native slash-command trigger. Users on Slack type `\compact` and the
orchestrator normalises it to `/compact` before any routing decisions are made. The trigger pattern is stripped
first, so `@nanoclaw \compact` and `\compact` both resolve to `/compact`.

Note the regex requires the command to be a single word with no arguments. Multi-word prompts that happen to start
with `/` (for example, `/recall the meeting`) are not treated as commands and are passed to the agent as normal
text.

## 6. How to Add a New Command

Decide which of the three categories the command belongs to:

- **Host-intercepted** — if it does not need agent context (status, billing, rate limits, etc.). Add the literal
  to `INTERCEPTED_COMMANDS` in [`src/session-commands.ts:5`](../src/session-commands.ts), add a branch to
  `executeHostCommand()` in [`src/host-commands.ts:315`](../src/host-commands.ts), and add the command to
  `READ_ONLY_COMMANDS` ([`src/session-commands.ts:8`](../src/session-commands.ts)) unless it modifies state. Host
  commands run inline in the message loop and return a single response string.
- **Agent-runner-intercepted** — if it needs container filesystem access but should not consume an SDK turn
  (session manipulation, skill listing, etc.). Add a branch to the slash-command block in
  [`container/agent-runner/src/index.ts:649-677`](../container/agent-runner/src/index.ts) that returns via
  `writeOutput()` and `return`s before the SDK query starts. Update `READ_ONLY_COMMANDS` if appropriate.
- **SDK-forwarded** — if the SDK already implements the command, do nothing. Any unrecognised single-word `/cmd`
  is forwarded automatically; the user will see the SDK's "Available commands" list if it does not recognise
  the input.

Whichever path you choose, add a test in [`src/session-commands.test.ts`](../src/session-commands.test.ts) that
asserts the new command's category (`isInterceptedCommand`, `isReadOnlyCommand`) and a row to the reference table
in this document.
