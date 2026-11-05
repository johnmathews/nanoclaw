# 8. Section 08 — deep intents for the three remaining PORT items

Extracted 2026-11-02, verified against upstream tag **`v2026.10.0`**. These are the items
`07-since-june-rebuild.md` §7.9 flagged as needing the same treatment sections 01–06 give
their features.

**Outcome: only two of the three are ports.** Reject-with-reason turned out to be an
upstream feature — see §8.3, which records the correction so nobody re-ports it.

> Recover bodies with `git show <sha>` or `git show <sha> -- <path>`.

## 8.1 Silent-turn recovery — PORT

**Origin:** fork-original. **Commits:** `9253c9d1` (mechanism), `36e6b4f4` (hardened nudge
text), `2a060413` (per-batch flag reset, fork PR #734).
**Verified fork-only:** `silentNudgeStreak`, `getOutboundWriteCount`, `turnExpectsReply`,
`expectsReply`, and the literal `Delivery check` string all return **0** files at the tag.
**Reference reading:** `docs/operational-gotchas.md` items **32** and **33**, and
`journal/260702-fix-silent-turn-nudge-on-task-after-chat.md`.

### 8.1.1 Intent

A turn can end having delivered **nothing** — the model returns empty text, or an
`<internal>`-only body that strips to nothing. For a **task** or **system** trigger that is
often legitimate (delivered by email, posted mid-turn via `send_message`, or a reconnect ack
needing no action). For a **human chat message** it is a dropped reply: the user sees silence
and has to poke the chat with `"?"` to shake the reply loose. Channel-agnostic — observed on
WhatsApp, Financial Times, HackerNews and Managers' Guide.

The fix detects the silent chat turn in the agent-runner and pushes one `<system>` nudge so
the model can recover its own dropped reply.

### 8.1.2 Files

`container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/db/messages-out.ts`,
`container/agent-runner/src/mcp-tools/core.instructions.md`, and the `silent-turn recovery`
block in `container/agent-runner/src/poll-loop.test.ts` (5 cases).

### 8.1.3 How to apply

1. **Outbound write counter** — in `db/messages-out.ts` add a module-level
   `let outboundWriteCount = 0;`, increment it in **every** path that writes a `messages_out`
   row, and export:
   ```ts
   export function getOutboundWriteCount(): number { return outboundWriteCount; }
   ```
   Load-bearing: every delivery path must increment — final `<message>` blocks plus
   `send_message` / `send_file` / `edit_message` / `add_reaction`. A missed path makes the
   nudge fire on turns that did deliver.

2. **The `expectsReply` predicate** — in `poll-loop.ts`:
   ```ts
   function expectsReply(messages: MessageInRow[]): boolean {
     return messages.some((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
   }
   ```
   This is the whole task/chat distinction. Tasks, webhooks and system rows routinely
   complete in silence and must never trigger the nudge.

3. **Per-run state** in `processQuery`:
   ```ts
   let turnExpectsReply = initialExpectsReply;      // caller passes expectsReply(initialBatch)
   let silentNudgeStreak = 0;
   let deliveredCountAtTurnStart = getOutboundWriteCount();
   ```

4. **Rebind the flag per follow-up batch — do not latch it.** In the follow-up handler:
   ```ts
   silentNudgeStreak = 0;
   turnExpectsReply = expectsReply(keep);   // NOT `if (expectsReply(keep)) … = true`
   ```
   This one line is commit `2a060413`. Latching was the bug: an earlier chat message in the
   same `processQuery` run left the flag `true`, so a scheduled task firing later in the run
   got nudged into emitting an extra channel message — violating the "silent on routine
   success" contract for background tasks.

5. **The nudge, on every `result` event:**
   ```ts
   const deliveredThisTurn = getOutboundWriteCount() - deliveredCountAtTurnStart;
   const silentTurn =
     deliveredThisTurn === 0 && !willRetryWrapping && turnExpectsReply && silentNudgeStreak < 1;
   ```
   When true: increment the streak, log, and `query.push()` the nudge. When false: re-baseline
   `deliveredCountAtTurnStart = getOutboundWriteCount()`. **Only re-baseline in the else
   branch** — while a retry is in flight the baseline must stay put so the recovered result
   still counts as this turn's delivery.

6. **The nudge text must be factual, not permissive** (commit `36e6b4f4`). The original soft
   wording ("you may stay silent") let the model rationalise an `<internal>`-only "I already
   sent it via send_message" as a false alarm and stay silent. When the nudge fires we *know*
   `deliveredThisTurn === 0`, so asserting it is always true:
   ```
   <system>Delivery check: the outbound log for this turn is EMPTY — nothing reached the
   user. If you believe you already sent a reply (e.g. via send_message), that send did NOT
   record a delivery, or it answered an earlier message and the user's latest message is
   still unanswered. This is not a false alarm. Reply to the user's most recent message now,
   wrapped in <message to="name">...</message>. Do not respond with only <internal> — that
   delivers nothing.</system>
   ```

7. **Instruction reinforcement** — in `mcp-tools/core.instructions.md`: "Always reply to a
   user's chat message … stay silent only when a task explicitly tells you to."

8. **Keep the triggering prompt queued** while a retry (wrapping or silent) is in flight, so
   the recovered result archives against the real prompt rather than the nudge text.

### 8.1.4 Invariants and known limits

- **Capped at one nudge per silent run** (`silentNudgeStreak < 1`, re-armed on fresh input) so
  a model that means to stay silent can never be looped.
- **Skipped while a wrapping retry already covers the turn** (`willRetryWrapping`).
- **Residual:** if the model ignores even the hardened nudge the turn still ends silent —
  bounded and rare. This is a recovery band-aid for the manual-`"?"` symptom; it does not stop
  the model producing an empty turn.
- **Known tradeoff from step 4:** if a chat message's reply has not been delivered yet and a
  task follow-up lands in the same run *before* the chat's turn-end fires, the flag clears and
  that chat's nudge is suppressed. Rare in practice (the chat's turn-end normally fires first).
  The fix, if it ever bites, is a "delivered-since-last-chat" tracker.
- **Deeper fix, deliberately deferred** (gotcha 32): the root cause is async multiplexing —
  nanoclaw batches inbound messages and `query.push()`es follow-ups into a running turn, so the
  model loses the clean "this input needs exactly one reply" framing. The real fix binds each
  inbound `chat`/`chat-sdk` row to a *required* delivery and does not let a follow-up absorb an
  unanswered message. **Re-evaluate on upstream before porting the nudge:** upstream's turn and
  batching model has moved, and if it now binds replies to rows the nudge may be unnecessary.

### 8.1.5 Deployment note

The agent-runner source is **bind-mounted read-only** into `/app/src`, not baked into the
image, so a source edit needs no image rebuild and no host restart — it applies to the next
container that **cold-starts**. A warm container keeps the old code in memory until it cycles;
`ncl groups restart` forces it.

## 8.2 Outbound-loss guard — PORT, rebased onto upstream's attempt bookkeeping

**Origin:** fork-original. **Commits:** `ef38c0f4` (taxonomy + dispositions), `2c7f6245`
(WhatsApp prompt delivery).
**Verified fork-only:** `ChannelDisconnectedError`, `PermanentDeliveryError`,
`classifyDeliveryError`, `markDeliveryDeferred`, `surfaceDeliveryFailure` and the `'deferred'`
status all return **0** files at the tag. Upstream's `src/delivery-guard.ts` is unrelated — it
is the approval/guard consult path for privileged delivery actions, not failure handling.
**Reference reading:** `journal/260622-fix-silent-message-loss-delivery.md`,
`docs/db-session.md`.

### 8.2.1 Intent

The agent "sends" by writing a row to `outbound.db`. That write always succeeds, which is why
the agent can always recall the text. Whether it reaches the user is a separate host step. The
delivery loop treated **any non-throwing return from `deliver()` as proof of delivery** — and
several adapter paths returned `undefined`-as-success without sending:

1. **WhatsApp `sendRawMessage`** swallowed disconnect and send errors into an **in-memory**
   queue (lost on restart; the flush was itself lossy — `shift()` before an un-try/caught
   `await`) and returned `undefined`.
2. **`createChannelDeliveryAdapter`** logged-and-returned when no adapter was registered.
3. **Permanent Slack errors** (`missing_scope`, `message_not_found`) threw, so they hit the
   retry path, but after 3 quick retries were marked `failed` and **never surfaced** —
   and `getDeliveredIds` returned `failed` rows, so they were never re-driven either.

In every case the agent's outbound row persisted, so it "remembered" sending a message the
user never got.

### 8.2.2 The cardinal rule to re-establish

**An adapter's `deliver()` returning normally means the message reached the platform.** An
adapter that cannot send **throws**. `undefined` is reserved for operations that legitimately
produce no platform message id — reactions, edits, intentionally-skipped empties.

### 8.2.3 How to apply

1. **Copy `src/channels/delivery-errors.ts` essentially verbatim** — it is self-contained and
   has no upstream counterpart: `ChannelDisconnectedError`, `PermanentDeliveryError` (carrying
   a short machine-ish `reason`), the `PERMANENT_PLATFORM_ERRORS` substring list (auth/
   permission, routing/target, malformed-payload codes), and
   `classifyDeliveryError(err): 'permanent' | 'disconnected' | 'transient'`.

2. **Make the adapters throw.** `whatsapp.ts`: `sendRawMessage` throws
   `ChannelDisconnectedError` when not connected and lets send errors propagate; **delete the
   in-memory outgoing queue entirely**; add the same connected-guard to the file-send path.
   `channel-registry.ts`: throw `ChannelDisconnectedError` when no adapter is registered.
   In `delivery.ts`, "no adapter configured" throws `ChannelDisconnectedError` and the
   routing/ACL rejections throw `PermanentDeliveryError`.

3. **Branch the per-message catch on disposition** — constants
   `MAX_DELIVERY_ATTEMPTS = 3`, `DEFERRAL_BACKOFF_BASE_SEC = 15`,
   `DEFERRAL_BACKOFF_MAX_SEC = 120`, with
   `min(MAX, BASE * 2 ** (attempts - 1))`:

   | Disposition | Action |
   |---|---|
   | `disconnected` | Defer with exponential backoff (15s → 120s). **Never** counts against the retry budget, **never** terminal; re-driven across restarts until the channel recovers. |
   | `permanent` | Mark failed immediately **and surface to the agent**. Never retried — retrying just hammers the platform API. |
   | `transient` | 3 immediate retries, then fail **and surface**. |

4. **Re-home the deferral bookkeeping — this is the part that must NOT be copied.** The fork
   stored `attempts` / `next_attempt_at` and a third `delivered.status='deferred'` on the
   **session** DB's `delivered` table (`src/db/schema.ts` + a lazy `migrateDeliveredTable`).
   Upstream now has durable, restart-surviving attempt bookkeeping of its own in the **central**
   DB: the `delivery_attempts` table (migration `024-host-coordination.ts`) with `attempts`,
   `last_attempt_at`, `next_attempt_at`, `last_error`, accessed via `src/db/coordination.ts`
   — see `src/delivery-attempts-authority.test.ts` for the contract ("attempt counts are read
   from rows, not process memory, so a host restart no longer resets them").
   **Port the taxonomy and the three-way branch onto upstream's table.** Keep these two
   fork invariants whichever table holds the state:
   - The undelivered set must **exclude** deferred rows (the fork narrowed `getDeliveredIds`
     to terminal statuses only) so a deferred message is re-driven after a restart.
   - Terminal marks must be **`INSERT OR REPLACE`**, not `OR IGNORE` — otherwise a stale
     `deferred` row survives a successful send and the message is delivered twice.
   Note the fork also kept a process-memory map for *transient* attempts, deliberately resetting
   on restart; upstream's durable table supersedes that, so drop the map.

5. **Surfacing** — `surfaceDeliveryFailure(msg, inDb, err)`: on a terminal failure write a
   **context-only (`trigger=0`)** notice into the inbound mailbox so the agent learns its
   message never landed **without** waking a deliver→notify→deliver loop; it rides along on the
   agent's next real turn. Body: a `⚠️ System notice` naming the destination
   (`<channel_type>/<platform_id>`) and the reason, plus up to 200 chars of the undelivered
   message as a preview (parsed from `markdown` or `text`; omitted if the content is not JSON).
   Row id `delivery-fail-<msg.id>`. On upstream this write goes through `src/mailbox/`.

6. **WhatsApp prompt delivery (`2c7f6245`)** — a separate, smaller fix in the same area:
   replies were only delivered on the *next* inbound message rather than promptly. Touches
   `src/channels/adapter.ts`, `src/channels/whatsapp.ts`, `src/delivery.ts`, `src/index.ts`.
   Re-apply with §2.3, and see `journal/260622-fix-whatsapp-delivery-stall.md` plus the
   `docs/operational-gotchas.md` entry (item 31, poll-driven delivery + the WhatsApp socket).

### 8.2.4 Tests to recreate

Four delivery cases: offline-defer-then-reconnect; never-burns-budget-while-offline;
surface-on-permanent; surface-on-exhaustion. Plus the `channel-registry` test that asserted
the **old** silent-drop behaviour needs inverting to assert the throw.

## 8.3 Reject-with-reason — RETRACTED, upstream has it

`07-since-june-rebuild.md` §7.3 listed `f826de71` as **PORT** on the strength of a probe for
`declineReason|decline_reason|rejectReason`, which returns 0 files. **That probe used the
wrong names.** The feature's actual vocabulary is present at the tag:

| Term | Files at `v2026.10.0` |
|---|---|
| `awaiting_reason` | 7 |
| `reason-capture` (file) | 2 |
| `"Reject with reason"` | 11 |

`f826de71` is itself a cherry-pick — its trailer reads *"(cherry picked from commit
`e8148bc0`)"*, and `e8148bc0` is reachable from `upstream/main`. The author is not a fork
contributor. So this is upstream's feature, already in the fork by cherry-pick.

**Verdict: DROP.** Take upstream's implementation. Nothing to port.

**Lesson for the rest of the replay:** a zero-hit grep is only evidence if the search terms
are the feature's real vocabulary. Probe for the schema values, file names and user-visible
strings — not for the names you would have chosen.
