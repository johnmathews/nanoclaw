# W4.x-slack-interactivity port — send_blocks + ncv2: namespace

Date: 2026-05-22. Tags: feature, decision.

Closes the v1→v2 migration gap surfaced by [p3-notes.md §17 / §17.9](../docs/v2-migration/p3-notes.md): v2's
chat-sdk bridge had no path to send raw Slack Block Kit blocks, and no path to receive non-`ncq:` action_id
clicks back to the agent. The Mon/Thu 02:03 CEST git-maintenance cron uses both, so it would have broken
silently on the next fire (2026-05-25T00:03Z).

## What was broken

Three discrete gaps stacked:

1. **`send_blocks` MCP tool did not exist on v2.** The git-maintenance cron's prompt and group CLAUDE.local.md
   both told the agent to call `send_blocks` to post a Block Kit report with checkboxes. The tool's absence
   meant the agent would get a tool-not-found error, fall through to a plain text reply, and produce no
   interactive UI.
2. **The bridge filtered every non-`ncq:` action click.** Even if the agent had a path to post a Block Kit
   payload via some other means, the bridge's `chat.onAction` handler dropped everything except `ncq:`-prefixed
   action_ids at line 270. v1's `nanoclaw_checkbox_branches` + `nanoclaw_confirm_delete` action_ids would
   never have reached the agent.
3. **The Chat SDK can't carry raw Block Kit on Slack.** `@chat-adapter/slack`'s `postMessage` takes an
   `AdapterPostableMessage` (`string | PostableRaw | PostableMarkdown | PostableAst | PostableCard | CardElement`).
   None of those carry raw Block Kit, and the abstract Card primitive can't express checkboxes, multi-select,
   datepickers, or accessory layouts — all features the v1 `send_blocks` contract relied on. So even with a
   tool and a bridge filter in place, the underlying transport wouldn't have rendered the report.

## What we built

Three layers, mirroring the three gaps above. All additive — no existing behaviour changed.

### 1. `send_blocks` MCP tool

[`container/agent-runner/src/mcp-tools/interactive.ts`](../container/agent-runner/src/mcp-tools/interactive.ts).
Sibling of `send_card`. Accepts `blocks` (array OR JSON string — Claude tends to stringify tool-arg objects
unprompted) plus a required `fallbackText`. Writes a `messages_out` row with content
`{ type: 'blocks', blocks, fallbackText }`. Validates: blocks must decode to an array; fallbackText must be
non-empty. Tests in `interactive.test.ts` (bun:test).

### 2. Bridge `content.type === 'blocks'` delivery branch

[`src/channels/chat-sdk-bridge.ts`](../src/channels/chat-sdk-bridge.ts) `deliver()`. Recognises the new content
shape before the existing `send_card` branch. Optional `config.postBlocks` capability — channels that can render
raw Block Kit supply one; others fall back to posting `fallbackText` via `adapter.postMessage`. If `postBlocks`
throws, the bridge logs and falls back to fallbackText so the agent's intent surfaces somehow rather than being
silently dropped. Empty fallbackText with no `postBlocks` → skipped with a warn log (matches `send_card`
empty-payload semantics).

### 3. Slack channel `postBlocks` impl via private WebClient cast

[`src/channels/slack.ts`](../src/channels/slack.ts) `makeSlackPostBlocks`. Reaches into the
`@chat-adapter/slack` adapter's *private* `client` (WebClient) field via a typed structural cast — necessary
because of layer-3 above. Decodes the Slack threadId encoding (`slack:CHANNEL:THREAD_TS`), calls
`client.chat.postMessage({ channel, thread_ts, text, blocks, unfurl_links: false, unfurl_media: false })`
directly. Defensive: returns null when the adapter's `.client.chat.postMessage` shape isn't there (future
`@chat-adapter/slack` version bumps), so the bridge falls back to fallbackText instead of crashing.

### 4. `ncv2:` action_id namespace + synthetic inbound

Bridge `chat.onAction` recognises `ncv2:`-prefixed action_ids BEFORE the existing `ncq:` branch. Strips the
prefix, synthesises a `kind=chat-sdk` inbound message via a new pure helper `buildNcv2Inbound()` (factored out
so the inbound shape stays testable without spinning up a full Chat SDK instance), and forwards through
`setupConfig.onInbound(channelId, threadId, inbound)` — same path as a normal message. All router/wiring logic
(agent_group lookup, session selection, mention-mode handling) "just works" without bridge-side knowledge of
the group config.

The synthetic inbound:

```ts
{
  id: `act-${Date.now()}-${rand}`,
  kind: 'chat-sdk',
  content: {
    text: '(button clicked) action_id="confirm_delete" value="..." by John',
    sender: 'John', senderId: 'U01HJOHN',
    action: { actionId, value, userId, messageId },
  },
  timestamp: ISO,
  isMention: true,  // mention-mode wirings still engage on the click
  isGroup: true,
}
```

The agent sees the click as a human-readable `<message>` line in its prompt and can read the JSON-encoded
`action` object from the same row content blob if it needs the structured value.

## Alternatives considered

**Option A (from §17.9): rewrite the cron prompt to use `ask_user_question`.** Zero v2 code change. Rejected
because the UX delta is too steep — N branches × one Block Kit checklist with multi-select becomes N sequential
ask-user-question round-trips (or one ask-user-question that only picks one branch at a time). The
maintenance flow surfaces ~5-15 branches typically; sequential confirmation is significantly worse.

**Option C: add `@slack/web-api` as a direct dependency and construct a parallel WebClient.** Rejected because
`@slack/web-api` is already loaded transitively via `@chat-adapter/slack`, and a parallel client would
double-allocate TLS connection pools / token refresh state. The private-field cast costs nothing at runtime
and is defensively shape-checked.

**Option D: extend the chat-sdk-bridge interface in the SDK itself (upstream PR).** Out of scope for this
session and orthogonal to the migration's exit criteria.

## Operational surprises worth recording

**Slack checkbox state isn't re-delivered with the button click.** Discovered while drafting the
git-maintenance CLAUDE.local.md update. Slack fires one `block_actions` payload per discrete user action — tick
5 checkboxes → 5 events, each carrying only that one option's value. The eventual `confirm_delete` button click
carries an empty value, NOT the current checkbox state. So agents using checkbox+button pairs MUST persist the
pre-selected option list in group memory keyed off the post timestamp and look it up at click time. The
CLAUDE.local.md edit covers this requirement; the cron's first live fire on 2026-05-25 will tell us whether
the agent internalises the new pattern or needs a nudge.

**Reaching into private fields of vendored adapters is brittle but justified here.** The Chat SDK abstracts
over Slack/Discord/Teams/Webex/iMessage/Matrix/email and necessarily flattens to a least-common-denominator
postMessage shape. When the v1 fork's load-bearing UX (one-page Block Kit checklist confirm flow) depends on
Slack-specific features, the choice is: drop the feature, or break abstraction. We broke abstraction — guarded
by a defensive shape check + fallback. Re-review on every `@chat-adapter/slack` version bump.

## What's now possible that wasn't before

Any agent on v2 can now post raw Slack Block Kit via `send_blocks` and receive `ncv2:`-prefixed action clicks
as synthetic chat-sdk inbound messages. The pattern is documented in `groups/slack_git-maintenance/CLAUDE.local.md`.

## What's still off-limits

- Block Kit on non-Slack channels falls back to fallback text. Discord and Telegram don't have an equivalent
  surface; cross-platform interactive UIs still belong to `send_card` (Chat SDK Card primitives, which the
  bridge already wires across all chat-sdk adapters).
- `chat.onModalSubmit`, `chat.onSlashCommand` — out of scope (see [p3-notes.md §17.5](../docs/v2-migration/p3-notes.md)).

## Files touched

```
container/agent-runner/src/mcp-tools/interactive.ts      (new tool)
container/agent-runner/src/mcp-tools/interactive.test.ts (new, bun:test)
src/channels/chat-sdk-bridge.ts                          (deliver + onAction extensions + helper)
src/channels/chat-sdk-bridge.test.ts                     (+9 tests: 4 for helper, 5 for deliver)
src/channels/slack.ts                                    (postBlocks impl)
groups/slack_git-maintenance/CLAUDE.local.md             (untracked — action_id repoint + Slack quirk doc)
docs/v2-migration/p3-notes.md                            (§18 resolution log)
docs/v2-migration/implementation-plan.md                 (W4.8 marked DONE)
docs/v2-migration/next-session-prompt.md                 (refreshed)
docs/v2-migration/fork-local-inventory.md                (slack.ts customization line resolved)
```

Test suite: 37 files / 433 tests passed (was 424). Agent-runner bun:test tests (+5) deferred — bun runs in
the container, not on the host.

## Caveats — first live verification still pending

The cron next fires `2026-05-25T00:03:00Z` (Mon 04:03 CEST). That's the first end-to-end smoke test of the
full path. Until then, all confidence is from unit tests + service-startup health.

Likely first-fire failure modes to watch for:

1. **Agent uses `nanoclaw_*` action_ids out of muscle memory.** The cron prompt + CLAUDE.local.md are
   declarative; the model still has to pick `ncv2:checkbox_branches`. Verify in the rendered card.
2. **Agent doesn't persist the pre-selected branch list to group memory.** The eventual confirm_delete click
   has nothing to act on. Confirm or correct.
3. **`@chat-adapter/slack`'s `chat.onAction` doesn't actually surface non-`ncq:` clicks at all.** Unlikely
   given the bridge can see `ncq:` clicks, but if all action ids are filtered upstream before reaching the
   bridge, this would only surface at first live test. Read the bridge's `onAction` dispatch log next Monday
   morning.
