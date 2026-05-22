# Next-session prompt — continue NanoClaw v1→v2 migration after chat-sdk-bridge audit (§17 + §17.9)

Copy the block below (everything between the `---` lines) into a new Claude Code session in `/srv/apps/nanoclaw-v2` to
continue the migration. The prompt is self-contained — the new session won't see this conversation.

> **Note on working directory:** canonical tree is `/srv/apps/nanoclaw-v2`. Start the next session there.
> `/srv/apps/nanoclaw` stays as the v1 tombstone for ~30 days.

---

I'm continuing the NanoClaw v1→v2 migration. **State as of 2026-05-22 post-bridge-audit:** P0 + P1 + P2 + P3 + W4.0
+ W4.3 + W4.5 + W4.4 + Task A + W4.5.1 + `writeOutboundDirect` rw fix + W4.1 sender-allowlist retire + v2 installer-
template watchdog patch + **chat-sdk-bridge audit (§17 + §17.9)** all complete. v2 is live in production at
`/srv/apps/nanoclaw-v2` (`nanoclaw-v2-787facac.service`, active+enabled). v1 stopped+disabled. WhatsApp + Slack
inbound/outbound + scheduled tasks + `/health` on `127.0.0.1:3002` + chat `/usage` + chat `/status` + `ncl usage`
all working.

**Git topology** (unchanged from Task A):

```
johnmathews/nanoclaw          ← all fork work
├── main                       ← HEAD = d562a1b    (FIVE HEAD commits LOCAL ONLY,
├── v1-archive                 ← v1 frozen at 0bd42bb     not yet pushed to origin)
└── v1-final-2026-05-22 (tag)  ← annotated tag on 0bd42bb

On /srv/apps/nanoclaw-v2 (canonical working tree):
  origin    → https://github.com/johnmathews/nanoclaw.git
  upstream  → https://github.com/nanocoai/nanoclaw.git

On /srv/apps/nanoclaw (v1 tombstone — DO NOT `git pull` here):
  origin    → https://github.com/johnmathews/nanoclaw.git
  Local main still = 0bd42bb (diverges from remote main).
  Leave intact while journal mount uses /srv/apps/nanoclaw/journal/.
```

**Read first**, in this order (all paths inside `/srv/apps/nanoclaw-v2`):

    docs/v2-migration/p3-notes.md              §10 W4.3, §11 W4.5, §12 fork restructuring,
                                               §13 W4.4, §14 W4.5.1 + writeOutboundDirect
                                               fix, §15 W4.1 retire, §16 installer-template
                                               watchdog patch, §17 chat-sdk-bridge audit,
                                               §17.9 git-maintenance cron NOT self-resolved.
    docs/v2-migration/implementation-plan.md   §5 P4 remaining order: W4.x-slack-interactivity
                                               (urgent — broken in prod) → W4.x-multimodal →
                                               W4.x-reactions-inbound → W4.7 Journal verify.
    docs/v2-migration/fork-local-inventory.md  Updated 2026-05-22: sender-allowlist +
                                               mount-security retired; health/watchdog/usage/
                                               status all done.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-22
post-audit. Read items #34-#36 in operational gotchas: provider interface is text-only (load-bearing for multimodal);
bridge `chat.onAction` is catch-all but filters at line 270 (wire path exists for interactivity); attachments are
downloaded by bridge but discarded by formatter (dead-letter).

## Working tree state on `/srv/apps/nanoclaw-v2` (start-of-session)

- Committed but **not yet pushed**: `574c7b1` (W4.1 retire docs), `7cde667` (installer-template watchdog patch),
  `c732e16` (next-session-prompt refresh), `fce147e` (§17 audit), `d562a1b` (§17.9 cron addendum). Five commits.
  Decide whether to `git push origin main` at session start.
- Uncommitted, deliberately: skill output from `/migrate-from-v1`, `/add-gmail-tool`, `/add-gcal-tool` — see project
  memory item #28 for the full list. Decide what to do with them as a separate concern.

## Pick one of these next units (in priority order)

### Option 1 (Recommended — urgent): W4.x-slack-interactivity port (~90-120 min)

**Production breakage on a known schedule.** The git-maintenance cron at
`messages_in[id=task-1775472071448-rpvh6c]` (group `ag-1779373702794-62oxsv`,
sess `sess-1779373704595-mqteww`, recurrence `3 2 * * 1,4` → next fire `2026-05-25T00:03:00Z`,
Mon CEST 04:03) calls `send_blocks` MCP tool (does not exist on v2) and uses actionIds
`nanoclaw_checkbox_branches` / `nanoclaw_confirm_delete` (would be dropped by bridge filter).

Per §17.9 recommendation — port the v1 pattern (option B in §17.9.):

1. Add `send_blocks` MCP tool in `container/agent-runner/src/mcp-tools/`:
   - Inputs: `blocks` (JSON string), `fallbackText` (string), `to` (optional destination name).
   - Behaviour: write a `messages_out` row with `content = { type: 'blocks', blocks, fallbackText }`.
   - Mirror the `send_card` shape; this is a sibling.
2. Extend bridge's `deliver()` in `src/channels/chat-sdk-bridge.ts` to recognise `content.type === 'blocks'`:
   - Call `adapter.postMessage(tid, { blocks: <parsed JSON>, fallbackText })`.
   - The Slack adapter's underlying API accepts raw blocks — verify via `@chat-adapter/slack` v4.26.0 type defs.
3. Extend bridge's `chat.onAction` handler to recognise a v2-prefixed actionId namespace.
   Suggested: `ncv2:<sessionId>:<actionId>` so the existing `ncq:` flow stays untouched.
   On match: emit a new `messages_in` row of `kind = 'chat-sdk'` with structured `action` payload
   (actionId, value, clicker user id, original messageId for context).
4. Update `groups/slack_git-maintenance/CLAUDE.local.md` to point at the new actionId namespace
   (`ncv2:<sessionId>:nanoclaw_checkbox_branches` etc.). Update the cron prompt similarly if needed.
5. Test end-to-end: trigger a manual fire of the git-maintenance task (via `ncl tasks` or DB write),
   confirm the agent posts a block with the new actionIds, click a checkbox in Slack, confirm the
   agent sees the action.
6. Commit + add §18 to `p3-notes.md`.

Alternative (option A in §17.9): rewrite the prompt + CLAUDE.local.md to use `ask_user_question`.
Zero code change, but UX degrades to sequential one-branch-at-a-time round-trips. Reject unless you
want to make a separate UX call.

### Option 2: W4.x-multimodal (~4-6 h)

Image + voice + PDF inbound binaries are downloaded by the bridge but discarded by the formatter
(dead-letter). The load-bearing change is widening `provider.query({ prompt: string })` to accept
content blocks. Then per-type handlers:

1. Widen the provider interface in `container/agent-runner/src/poll-loop.ts` to pass either a string
   prompt or a content-block array. The Claude provider needs to wrap in user message content.
2. Image: convert `attachments[i].data` (base64) into a Claude image content block in the message
   array. Skip when `skipImageMultimodal=true` per group config.
3. Voice: pre-process on the host before container spawn — call OpenAI Whisper API on the base64
   audio, store the transcription in `attachments[i].transcription`. Formatter renders inline.
   (Alternative: local whisper.cpp on Apple Silicon — see `/use-local-whisper` skill.)
4. PDF: pre-process on the host — call `pdftotext` CLI on the base64 data, store extracted text.
   Formatter renders inline. Apply the `/add-pdf-reader` skill behaviour.
5. Test for each attachment type. Per-group `skipImageMultimodal=true` should still work.
6. Commit + add §18 (or §19 if Option 1 also ran) to `p3-notes.md`.

### Option 3: W4.x-reactions-inbound (~2-3 h)

Bridge does not subscribe to `chat.onReaction()`. Chat SDK fires it; bridge ignores.

1. Verify `@chat-adapter/slack` v4.26.0 actually fires `onReaction` for Slack (the SDK type surface
   says yes; verify the adapter implements it before depending on it).
2. Subscribe in `src/channels/chat-sdk-bridge.ts` `setup()`: `chat.onReaction(async (event) => { … })`.
   Emit a `messages_in` row of kind `chat-sdk` with structured `reaction` field (emoji, added/removed,
   user, target messageId).
3. Add DB migration for a `reactions` table OR store on the existing `messages_in` row.
4. Add `query_reactions` MCP tool in `container/agent-runner/src/mcp-tools/core.ts` so agents can
   read the reaction state on a target message.
5. Commit + add §18/§19/§20 to `p3-notes.md`.

### Option 4: W4.7 Journal MCP cron verify (~10 min observe)

Wait until 09:05+ tomorrow (morning-report 07:28 + docs-summary 09:03 will have fired). Check the
main-group's outbound log for `mcp__journal__journal_*` tool invocations. Mark W4.7 done if green.

### Option 5: push pending commits + skill-output triage (~30 min)

`git push origin main` for the five LOCAL-ONLY commits. Decide whether to commit the deliberately-
uncommitted skill-output (project memory item #28). Lower-priority cleanup.

## Out of scope this session

- **Gmail channel re-install** — deferred.
- **W4.6 remote-control** — defer / nice-to-have.
- Anything in P5/P7/P8.
- Touching the systemd unit on the running install (NRestarts=0; keep it green).

## Operational gotchas (carry into this session)

1. **Canonical working tree** is `/srv/apps/nanoclaw-v2`. Start the next session there.
2. **Never restart v1's service** (`nanoclaw.service`). Stopped+disabled.
3. **`pnpm`** at `~/.npm-global/bin/pnpm`, **`onecli`** same dir, **`ncl`** at `/srv/apps/nanoclaw-v2/bin/ncl` —
   prefix `PATH=…:$PATH` or use absolute paths.
4. **v2's logs** at `/srv/apps/nanoclaw-v2/logs/nanoclaw.{log,error.log}`, not journald.
5. **v2 runs from `dist/`, not `src/`.** `cd /srv/apps/nanoclaw-v2 && pnpm run build` (= `tsc`) is mandatory
   between any host-source edit and `systemctl --user restart`.
6. **OneCLI gateway** runs on `127.0.0.1:10255`. 10254 is the web UI.
7. **`/health` reachable** at `127.0.0.1:3002`. After `systemctl --user restart`, sleep ≥6s before curling.
8. **`HOST_RESPONDER_COMMANDS` renderers** run fire-and-forget off the hot path (W4.5 pattern). Render failures
   fall back to inline error messages — original inbound row already marked processed (no retry).
9. **Mount allowlist** after P3+W4.5: 3 `allowedRoots` + `~/.calendar-mcp`. 17 `blockedPatterns`.
10. **v2 `additionalMounts` `containerPath` must be RELATIVE.** v2 prefixes with `/workspace/extra/`.
11. **DO NOT `git pull` on `/srv/apps/nanoclaw`.** It's the v1 working tree.
12. **Migration docs now live on v2's main** at `docs/v2-migration/`. Edit there.
13. **`writeOutboundDirect` now writes** (fixed in `d8c04b8`). Non-admin slash commands deliver "Permission
    denied" to the channel instead of failing silently.
14. **v2 installer-template now writes `Type=notify`** (fixed in `7cde667`). Fresh-install-only.
15. **Git author identity workaround**: no `user.name`/`user.email` set anywhere visible. Use
    `git -c user.name="John Mathews" -c user.email="mthwsjc@gmail.com" commit ...` per-command override.
16. **`v1-archive` branch is load-bearing for retire audits.** Read v1 files there or via `/srv/apps/nanoclaw`.
17. **v2's `provider.query({ prompt: string })` is text-only.** Load-bearing constraint for multimodal.
18. **Bridge's `chat.onAction` filter at line 270** drops non-`ncq:` actionIds. Wire path for Slack
    interactivity already exists at the bridge — gap is between bridge and agent, not platform and bridge.
19. **Attachments are dead-letter on v2.** Bridge downloads + base64-encodes; formatter renders
    `[<type>: <name>]` text only; provider takes a string prompt. All three layers need touching to
    fix multimodal.
20. **Git-maintenance cron task id** = `task-1775472071448-rpvh6c`, located at
    `data/v2-sessions/ag-1779373702794-62oxsv/sess-1779373704595-mqteww/inbound.db` `messages_in[kind=task]`.
    Recurrence `3 2 * * 1,4`. The cron is currently broken on v2 — see §17.9.

## Rollback recipes

- **For W4.x-slack-interactivity port**: `git revert <sha>` per commit + `pnpm run build` +
  `systemctl --user restart nanoclaw-v2-787facac.service`. The cron stays broken (its existing state).
- **For audit commits (574c7b1 onwards)**: all doc-only; `git revert <sha>` is safe.
- **For Task A topology**: `git push --force-with-lease origin v1-archive:main` from any working tree
  with `johnmathews/nanoclaw` as a remote. Restores v1 main.
- **For a service regression**: `git checkout -- <files>`; `pnpm run build`;
  `systemctl --user restart nanoclaw-v2-787facac.service`. Keep `NRestarts=0`.

## What to deliver this session

1. Whichever option(s) from §"Pick one of these next units" you tackled, with their per-section deliverables.
2. Tests pass (`cd /srv/apps/nanoclaw-v2 && pnpm test` — baseline is 37 files / 424 tests post-installer-template).
3. v2 healthy after any service-touching change (`curl http://127.0.0.1:3002/health` returns 200).
4. `project_v2_migration.md` memory updated with completed items + new operational gotchas.
5. **Decide on `git push origin main`** for the five LOCAL-ONLY commits.
6. End-of-session: produce a new next-session-prompt at `docs/v2-migration/next-session-prompt.md`.
