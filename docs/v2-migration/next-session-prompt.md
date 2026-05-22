# Next-session prompt — continue NanoClaw v1→v2 migration after W4.x-slack-interactivity (§18)

Copy the block below (everything between the `---` lines) into a new Claude Code session in `/srv/apps/nanoclaw-v2` to
continue the migration. The prompt is self-contained — the new session won't see this conversation.

---

I'm continuing the NanoClaw v1→v2 migration. **State as of 2026-05-22 post-W4.x-slack-interactivity:**
P0 + P1 + P2 + P3 + W4.0 + W4.3 + W4.5 + W4.4 + Task A + W4.5.1 + `writeOutboundDirect` rw fix + W4.1 sender-allowlist
retire + v2 installer-template watchdog patch + chat-sdk-bridge audit (§17 + §17.9) + skill-output commit batch +
**W4.x-slack-interactivity port (§18)** all complete. v2 is live in production at `/srv/apps/nanoclaw-v2`
(`nanoclaw-v2-787facac.service`, active+enabled). v1 stopped+disabled. WhatsApp + Slack inbound/outbound +
**interactivity (send_blocks + ncv2: action namespace)** + scheduled tasks + `/health` on `127.0.0.1:3002` + chat
`/usage` + chat `/status` + `ncl usage` all working. **Working tree is clean and everything is pushed to
`origin/main`.**

**Git topology** (unchanged from §18):

```
johnmathews/nanoclaw          ← all fork work, all current commits pushed
├── main                       ← HEAD = 559d0c7    (tracking origin/main)
├── v1-archive                 ← v1 frozen at 0bd42bb
└── v1-final-2026-05-22 (tag)  ← annotated tag on 0bd42bb

On /srv/apps/nanoclaw-v2 (canonical working tree):
  origin    → https://github.com/johnmathews/nanoclaw.git  (default push target for main)
  upstream  → https://github.com/nanocoai/nanoclaw.git     (read-only — fetch upstream NanoClaw updates)

On /srv/apps/nanoclaw (v1 tombstone — DO NOT `git pull` here):
  origin    → https://github.com/johnmathews/nanoclaw.git
  Local main still = 0bd42bb (diverges from remote main).
  Leave intact while journal mount uses /srv/apps/nanoclaw/journal/.
```

**Read first**, in this order (all paths inside `/srv/apps/nanoclaw-v2`):

    docs/v2-migration/p3-notes.md              §17 chat-sdk-bridge audit, §17.9 git-maintenance
                                               cron NOT self-resolved, §18 W4.x-slack-interactivity
                                               port (full mechanism + tests + gotchas).
    docs/v2-migration/implementation-plan.md   §5 P4 remaining order: W4.x-multimodal →
                                               W4.x-reactions-inbound → W4.7 Journal verify.
    docs/v2-migration/fork-local-inventory.md  Updated 2026-05-22: sender-allowlist +
                                               mount-security retired; health/watchdog/usage/
                                               status/Slack-interactivity all done.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-22
post-§18. **Read items #34-#39** in operational gotchas (provider interface text-only blocks multimodal; bridge
attachment dead-letter; Chat SDK postMessage can't carry raw Block Kit on Slack so we cast into the private
WebClient; Slack checkbox state isn't re-delivered with button clicks; `ncv2:` is the v2-canonical interactivity
action_id namespace).

## Working tree state on `/srv/apps/nanoclaw-v2` (start-of-session)

**Clean.** All §18-era work committed and pushed:
- `1142d0f` feat(slack): port Slack interactivity — send_blocks MCP + ncv2: action namespace
- `559d0c7` docs(v2-migration): §18 W4.x-slack-interactivity resolution log

`groups/slack_git-maintenance/CLAUDE.local.md` was edited on disk (action_ids repointed, Confirmation Handling
rewritten) but is intentionally not tracked — `.gitignore` excludes `groups/*`. The edit is preserved on disk and the
agent reads it at every container spawn. **`git status` should be empty when you start.**

## Pick one of these next units (in priority order)

### Option 1 (Recommended): W4.7 Journal MCP cron verify (~10 min observe)

The lowest-cost item. The morning-report (07:28) + docs-summary (09:03) crons fire on the main group's session.
After 09:05+ tomorrow, check the main group's outbound log for `mcp__journal__journal_*` tool invocations. If they're
landing cleanly, mark W4.7 done.

```bash
# Find main group session id
ncl groups list | grep main

# Tail the session's outbound for journal MCP calls
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/v2-sessions/ag-<main-id>/sess-<sess-id>/outbound.db', {readonly: true});
const rows = db.prepare(\"SELECT id, timestamp, content FROM messages_out ORDER BY timestamp DESC LIMIT 20\").all();
for (const r of rows) console.log(r.timestamp, r.content.slice(0, 200));
"
```

If green: append §19 to `p3-notes.md` (1-2 paragraphs); update memory.

### Option 2: First live verification of §18 (git-maintenance cron, Mon 04:03 CEST = 2026-05-25T00:03Z)

The cron fires Monday morning local time. Plan: leave a 09:00+ Monday morning session window to:

1. Open Slack, look at the git-maintenance channel for the freshly-posted Block Kit report.
2. Confirm the checkboxes render.
3. Click 1-2 checkboxes (or none, depending on the report).
4. Click the "Confirm Delete" button.
5. Confirm the agent receives the synthetic inbound (text + structured action), looks up the pre-selected branches
   from group memory, and acts on them.
6. If anything misfires: tail `/srv/apps/nanoclaw-v2/logs/nanoclaw.log` and the session's outbound.db for traces.

If the agent doesn't yet know to persist the pre-selected branch list to group memory keyed off the post timestamp,
the §18 CLAUDE.local.md edit covers it but the agent itself might not have internalised it (first time the prompt has
been run). Be ready to nudge it. Likely failure modes: (a) the agent posts the blocks fine but uses `nanoclaw_*`
action_ids out of muscle memory — verify in the rendered card; (b) the agent doesn't persist the pre-selected set, so
the eventual confirm_delete click has nothing to act on — confirm or correct.

Document outcome as §19 (or §20 if Option 1 also ran) in `p3-notes.md`.

### Option 3: W4.x-multimodal (~4-6 h)

Image + voice + PDF inbound binaries are downloaded by the bridge but discarded by the formatter (dead-letter). The
load-bearing change is widening `provider.query({ prompt: string })` to accept content blocks. Then per-type handlers:

1. Widen the provider interface in `container/agent-runner/src/poll-loop.ts` to pass either a string prompt or a
   content-block array. The Claude provider needs to wrap in user message content.
2. Image: convert `attachments[i].data` (base64) into a Claude image content block in the message array. Skip when
   `skipImageMultimodal=true` per group config.
3. Voice: pre-process on the host before container spawn — call OpenAI Whisper API on the base64 audio, store the
   transcription in `attachments[i].transcription`. Formatter renders inline. (Alternative: local whisper.cpp on
   Apple Silicon — see `/use-local-whisper` skill.)
4. PDF: pre-process on the host — call `pdftotext` CLI on the base64 data, store extracted text. Formatter renders
   inline. The `pdf-reader` container skill (bundled in `1b21950`) gives the agent the in-container PDF extraction
   path; the host-side prep is the missing half.
5. Test for each attachment type. Per-group `skipImageMultimodal=true` should still work.
6. Commit + add §19/§20 to `p3-notes.md`.

### Option 4: W4.x-reactions-inbound (~2-3 h)

Bridge does not subscribe to `chat.onReaction()`. Chat SDK fires it; bridge ignores.

1. Verify `@chat-adapter/slack` v4.26.0 actually fires `onReaction` for Slack (the SDK type surface says yes; verify
   the adapter implements it before depending on it).
2. Subscribe in `src/channels/chat-sdk-bridge.ts` `setup()`: `chat.onReaction(async (event) => { … })`. Emit a
   `messages_in` row of kind `chat-sdk` with structured `reaction` field (emoji, added/removed, user, target
   messageId).
3. Add DB migration for a `reactions` table OR store on the existing `messages_in` row.
4. Add `query_reactions` MCP tool in `container/agent-runner/src/mcp-tools/core.ts` so agents can read the reaction
   state on a target message.
5. Commit + add §19/§20 to `p3-notes.md`.

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
5. **v2 runs from `dist/`, not `src/`.** `cd /srv/apps/nanoclaw-v2 && pnpm run build` (= `tsc`) is mandatory between
   any host-source edit and `systemctl --user restart`.
6. **OneCLI gateway** runs on `127.0.0.1:10255`. 10254 is the web UI.
7. **`/health` reachable** at `127.0.0.1:3002`. After `systemctl --user restart`, sleep ≥6s before curling.
8. **`HOST_RESPONDER_COMMANDS` renderers** run fire-and-forget off the hot path (W4.5 pattern). Render failures fall
   back to inline error messages — original inbound row already marked processed (no retry).
9. **Mount allowlist** after P3+W4.5: 3 `allowedRoots` + `~/.calendar-mcp`. 17 `blockedPatterns`.
10. **v2 `additionalMounts` `containerPath` must be RELATIVE.** v2 prefixes with `/workspace/extra/`.
11. **DO NOT `git pull` on `/srv/apps/nanoclaw`.** It's the v1 working tree.
12. **Migration docs now live on v2's main** at `docs/v2-migration/`. Edit there.
13. **`writeOutboundDirect` now writes** (fixed in `d8c04b8`).
14. **v2 installer-template now writes `Type=notify`** (fixed in `7cde667`).
15. **Git author identity workaround**: no `user.name`/`user.email` set anywhere visible. Use
    `git -c user.name="John Mathews" -c user.email="mthwsjc@gmail.com" commit ...` per-command override.
16. **`v1-archive` branch is load-bearing for retire audits.**
17. **v2's `provider.query({ prompt: string })` is text-only.** Load-bearing constraint for multimodal.
18. **Bridge's `chat.onAction` filter order:** `ncv2:` (W4.x-slack-interactivity) → `ncq:` (ask_user_question) → drop.
19. **Attachments are dead-letter on v2.** Bridge downloads + base64-encodes; formatter renders `[<type>: <name>]`
    text only.
20. **Chat SDK `postMessage` can't carry raw Block Kit on Slack.** v2's Slack channel casts into the private
    WebClient via a typed structural check (`src/channels/slack.ts` `makeSlackPostBlocks`). Brittle across
    `@chat-adapter/slack` version bumps — re-review on every bump.
21. **Slack checkbox state isn't re-delivered with button clicks.** Agents using checkbox+button pairs MUST persist
    the pre-selected option list in group memory keyed off the post timestamp and look it up at click time.
    Documented in `groups/slack_git-maintenance/CLAUDE.local.md`.
22. **`ncv2:` is the v2-canonical Slack interactivity action_id prefix.** Bridge `chat.onAction` routes `ncv2:*` to
    the agent as a synthetic chat-sdk inbound (text + structured `action` payload). Anything not prefixed `ncv2:` or
    `ncq:` is silently dropped.
23. **Git-maintenance cron task id** = `task-1775472071448-rpvh6c`, located at
    `data/v2-sessions/ag-1779373702794-62oxsv/sess-1779373704595-mqteww/inbound.db`. Recurrence `3 2 * * 1,4`. Next
    fire `2026-05-25T00:03:00Z`. First live test of §18.
24. **`main` tracks `origin/main`.** Bare `git push` goes to the fork; `git fetch upstream` still works.
25. **`groups/*/CLAUDE.md` files are NOT tracked.** `.gitignore` excludes `groups/*`. Never `git add` anything under
    `groups/`. Includes the §18 edits to `groups/slack_git-maintenance/CLAUDE.local.md`.

## Rollback recipes

- **For §18 (W4.x-slack-interactivity)**: `git revert 1142d0f 559d0c7` + `pnpm run build` + `systemctl --user
  restart nanoclaw-v2-787facac.service`. The cron then breaks on next fire — but it would also have broken without
  §18. Net: no worse than pre-§18.
- **For the skill-output commits (b952767 / 1b21950)**: `git revert <sha>`, then `pnpm install` and
  `./container/build.sh` if reverting the container/Dockerfile commit. Be aware: reverting `b952767` would also
  un-register the channel adapters and stop v2's live channels from initialising — almost certainly not what you
  want.
- **For Task A topology**: `git push --force-with-lease origin v1-archive:main` from any working tree with
  `johnmathews/nanoclaw` as a remote. Restores v1 main.
- **For a service regression**: `git checkout -- <files>`; `pnpm run build`; `systemctl --user restart
  nanoclaw-v2-787facac.service`. Keep `NRestarts=0`.

## What to deliver this session

1. Whichever option(s) from §"Pick one of these next units" you tackled, with their per-section deliverables.
2. Tests pass (`cd /srv/apps/nanoclaw-v2 && pnpm test` — baseline is 37 files / 433 tests).
3. v2 healthy after any service-touching change (`curl http://127.0.0.1:3002/health` returns 200).
4. `project_v2_migration.md` memory updated with completed items + new operational gotchas.
5. `git push origin main` at end of session (tracking is sane — bare `git push` works).
6. End-of-session: produce a new next-session-prompt at `docs/v2-migration/next-session-prompt.md`.
