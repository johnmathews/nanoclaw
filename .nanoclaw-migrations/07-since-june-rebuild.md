# 7. Section 07 — fork work since the June rebuild

Inventory of the **42 fork-local commits** in `1c9ff93c..HEAD` (2026-06-15 → 2026-11-02).
These post-date sections 01–06 and were never documented as intents. Compiled 2026-11-02,
verified against upstream tag **`v2026.10.0`**.

> Recover any body with `git show <sha>` or `git show <sha> -- <path>`.

**Confidence labels.** **DROP** = upstream ships its own implementation (named below).
**PORT** = verified 0 upstream occurrences. **VERIFY** = upstream has related code that
probably covers it, but equivalence was not confirmed — check before porting or dropping.

## 7.1 Headline: most of this section is already upstream

The two largest clusters — agent-to-agent approval policies and the approvals-model
refactors — are upstream features at this tag. That is the single biggest saving in the
whole replay, and it means **adopting upstream's version, then diffing for behavioural
nuances**, rather than replaying ~20 commits.

## 7.2 Agent-to-agent per-message approval policies — DROP (adopt upstream)

**Commits (15):** `8cb499e4`, `0d632b71`, `8aebdc2c`, `dbfe233b`, `fa5d6806`, `604870ac`,
`61c9d192`, `6c0f6bb5`, `73a4b0f3`, `f985441c`, `5496d921`, `8d1da36f`, `acad71e3`,
`6803c3bf`, plus the migration in `3ed392e2`.

**Fork shape:** `agent_message_policies` table via `module-agent-message-policies.ts`,
`src/cli/resources/policies.ts`, gate logic in `src/modules/agent-to-agent/agent-route.ts`
and `message-gate.ts`, with a mandatory single approver per policy that may be the source or
the target group, and a clarified gate prompt.

**Upstream at this tag has the same feature:** migration
`src/db/migrations/017-agent-message-policies.ts`, `src/cli/resources/policies.ts`,
`src/guard/guard.ts`, and `agent-to-agent/agent-route.ts` integration.

**Action:** take upstream's. Then diff these specific fork behaviours and re-apply only the
ones you still want: (a) approver is **mandatory** per policy; (b) approver may be the
source *or* target group's admin; (c) the reworded gate prompt (`6803c3bf`); (d) strict
resolution — only the named user may resolve (`c6a22695`). Do not port the fork's migration
or CLI resource file; they will collide with upstream's.

## 7.3 Approvals model and card rendering

| Commits | Item | Verdict |
|---|---|---|
| `3ed392e2` | Approver carried on a `pending_approvals` column instead of the payload | **DROP** — upstream migration `018-approvals-approver-user-id.ts` + `src/db/schema.ts` do this. |
| `c6a22695` | Strict approver — only the named user may resolve | **VERIFY** — upstream has the column; confirm it enforces strictly in `modules/approvals/response-handler.ts`, else re-apply. |
| `3a9dd645` | Render OneCLI approvals from the gateway's structured summary | **DROP** — upstream ships `src/gateway-approval-summary.ts` and `src/gateway-approval-presentation.ts`. |
| `447e5e75` | Colored buttons on approval cards (Slack primary/danger) | **VERIFY** — upstream has `danger`/`primary` styling in 12 files; confirm the approval card itself is styled before re-applying. |
| `f826de71` | **Reject-with-reason** — relay an optional decline reason back to the agent | **DROP (verdict corrected 2026-11-02)** — upstream has it: `awaiting_reason` (7 files), `reason-capture` (2), `"Reject with reason"` (11) at the tag. The commit is itself a cherry-pick of upstream `e8148bc0`. My first probe searched the wrong names. See `08-deep-intents.md` §8.3. |

## 7.4 Agent-runner turn handling

| Commits | Item | Verdict |
|---|---|---|
| `9253c9d1`, `36e6b4f4` | **Silent-turn auto-recovery** — a turn that produced no outbound message is nudged rather than dropped, hardened against "already sent" rationalisation | **PORT** — 0 upstream occurrences. `poll-loop.ts`, `db/messages-out.ts`, `mcp-tools/core.instructions.md`. See `docs/operational-gotchas.md` for the deferred deeper fix (`a4a5009e`). |
| `2a060413` | Reset `turnExpectsReply` per follow-up batch (fork PR #734) | **PORT** — same seam as above. |
| `b7c6f143` | Deliver budget/billing error turns instead of dropping them | **VERIFY** — upstream has billing/budget strings in 12 files; confirm the poll-loop delivers such turns. |
| `a89d9d0d`, `f082f772` | Match `rate_limit_event` as a top-level SDK message type (+ test) | **VERIFY** — upstream matches `rate_limit_event` in 6 files; likely covered by a later SDK bump. |
| `bf292fea` | a2a `in_reply_to` stamp published through `outbound.db` rather than module state | **VERIFY** — touches `current-batch.ts`, `db/session-state.ts`, `mcp-tools/core.ts`; check upstream's current batch/state model. |

## 7.5 Security and containment

| Commits | Item | Verdict |
|---|---|---|
| `27872853`, `e6046ae9` | Contain channel-inbound attachments via a shared inbox guard (`src/inbox-safety.ts`) — cherry-picked from upstream #2828 | **DROP — and upstream's is stronger.** Upstream replaced this with `src/anchored-dir.ts`, which addresses the mount trees by **handle rather than path** precisely because a container can swap any name for a symlink between the host's check and its next syscall. The fork's `isPathInside` / `ensureContainedInboxDir` is the path-based approach upstream rejected. Adopt `anchored-dir.ts`; do not port `inbox-safety.ts`. |
| `5b924fc1` | Restore the `/start` filter, remove the fail-open admin check in `command-gate.ts` | **VERIFY** — upstream references `'/start'` in 4 files; confirm there is no fail-open path before dropping. Security-relevant: check, don't assume. |
| `ee616690` | Mount allowlist honours the `readOnly` key; stop caching parse errors | **VERIFY** — upstream has `readOnly` in 4 mount-security files. Confirm both halves (the key *and* the error-cache fix). |

## 7.6 Delivery reliability

| Commits | Item | Verdict |
|---|---|---|
| `ef38c0f4` | Stop silently losing outbound messages on Slack & WhatsApp — adds `src/channels/delivery-errors.ts` | **PORT (rebase the bookkeeping)** — confirmed fork-only; upstream's `delivery-guard.ts` is the approval-consult path, unrelated. But upstream now has durable attempt bookkeeping in the central DB (`delivery_attempts`, migration `024-host-coordination.ts`), so port the taxonomy and dispositions **onto that** rather than the fork's session-DB `delivered` columns. Full intent: `08-deep-intents.md` §8.2. |
| `2c7f6245` | Deliver WhatsApp replies promptly rather than on the next inbound | **PORT** — WhatsApp is a `channels`-branch adapter; re-apply with §2.3. |

## 7.7 Container runtime and build

| Commits | Item | Verdict |
|---|---|---|
| `dacb45f8` | Build agent images asynchronously instead of blocking the host | **VERIFY** — one upstream file matched the probe. Upstream also moved image building toward prebuilt/hardened images (BREAKING #11), which may make this moot. |
| `e35bb0dd` | **Stop agent containers posting telemetry to Datadog** — `CLAUDE_CODE_QUIET_ENV` on every container | **PORT (rework)** — 0 upstream occurrences. Must be re-applied against the session-driver seam, not pasted into `container-runner.ts`. The env names are read out of the shipped Claude Code binary; re-verify them against whatever SDK version upstream pins. |
| `94ffd670` | OneCLI gateway 1.42.0 / CLI 2.2.5 pins + rewritten `docs/onecli-upgrades.md` | **MOSTLY DROP** — `/add-onecli` carries the same pins at this tag (gateway 1.42.0, cli 2.2.5, sdk 2.2.1) and ships its own copy of the upgrade doc. **Keep** the fork's additions to that doc that upstream lacks: the dump-is-the-only-rollback finding, the `DROP SCHEMA` restore recipe, and the `Authorization: Bearer placeholder` injection probe. Diff the two docs rather than overwriting either. |

## 7.8 Skills, config and docs

| Commits | Item | Verdict |
|---|---|---|
| `a209687f` | `slack-formatting` always-on instructions fragment for mrkdwn footguns | **PORT (relocate)** — the skill now ships from the `channels` branch with `/add-slack`, so the fragment must be re-applied there, not in `container/skills/`. |
| `376fb284`, `bab6be5f` | Test-isolation fixes (fork PRs #736, #738) — poll instead of fixed sleep; pass an abort signal into `runPollLoop` | **PORT if the tests are ported.** `bab6be5f` fixed a leaked signalless poll loop that stole other files' DB messages and kept CI red for ~3 weeks — carry the lesson even if the file shape changes. |
| `9e907b02` | Gitignore stray root-level `inbound/outbound.db` artifacts | **PORT** — one line, with §6.7. |
| `82b7c7ba`, `a4a5009e`, `acda17c6` | Journal and operational-gotchas entries | **PORT** — content only, with §6.9. |

## 7.9 Deep intents — extracted

The three items flagged here have been worked through in **`08-deep-intents.md`**, and one of
them evaporated:

| Item | Outcome |
|---|---|
| Silent-turn auto-recovery | **PORT** — full intent at §8.1, with the per-batch flag-reset bug, the hardened nudge text, the invariants, and a note to re-check upstream's batching model first. |
| Outbound-loss guard | **PORT** — full intent at §8.2, rebased onto upstream's `delivery_attempts` table. |
| Reject-with-reason | **DROP** — it is upstream's own feature; see §8.3. |

No further extraction is outstanding. Everything remaining in this section is either a
**DROP**, a **VERIFY** (a named upstream file to read before deciding), or small enough to
re-apply from the commit directly.
