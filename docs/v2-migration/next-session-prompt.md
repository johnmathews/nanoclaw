# Next-session prompt — continue NanoClaw v1→v2 migration after W4.7 + W4.x-multimodal + W4.x-reactions-inbound (§19 + §20)

Copy the block below (everything between the `---` lines) into a new Claude Code session in `/srv/apps/nanoclaw-v2` to
continue the migration. The prompt is self-contained — the new session won't see this conversation.

---

I'm continuing the NanoClaw v1→v2 migration. **State as of 2026-05-22 post-§20:**
P0 + P1 + P2 + P3 + W4.0 + W4.3 + W4.4 + W4.5 + W4.5.1 + W4.1 + Task A + writeOutboundDirect rw fix + v2 installer-template
watchdog patch + chat-sdk-bridge audit (§17) + skill-output commit batch + W4.x-slack-interactivity port (§18) + W4.8
journal-mirror + **W4.7 Journal MCP (§19)** + **W4.x-multimodal + W4.x-reactions-inbound (§20)** all complete. v2 is live
in production at `/srv/apps/nanoclaw-v2` (`nanoclaw-v2-787facac.service`, active+enabled). v1 stopped+disabled. WhatsApp +
Slack inbound/outbound + interactivity (`send_blocks` + `ncv2:` action namespace) + scheduled tasks + `/health` on
`127.0.0.1:3002` + chat `/usage` + chat `/status` + `ncl usage` all working. **Image attachments delivered as Claude
multimodal blocks. Voice attachments transcribed host-side via Whisper. PDF attachments extracted host-side via pdftotext.
Reactions land as chat-sdk inbound and are queryable via `mcp__nanoclaw__query_reactions`.** **Working tree is clean and
everything is pushed to `origin/main`.**

**Git topology** (unchanged from §18):

```
johnmathews/nanoclaw          ← all fork work, all current commits pushed
├── main                       ← HEAD = a12a111   (tracking origin/main)
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

    docs/v2-migration/p3-notes.md              §19 W4.7 (journal MCP via per-group container.json,
                                               not env-var path); §20 W4.x-multimodal + reactions;
                                               §21 Monday 2026-05-25 02:03 CEST (= 00:03 UTC)
                                               live-verify plan for §18 git-maintenance cron.
    docs/v2-migration/implementation-plan.md   §5 P4 ordering: P4 effectively closed except W4.6.
    docs/v2-migration/fork-local-inventory.md  src/transcription.ts row flipped to re-ported.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-22
post-§20. **Read items #40-#46** in operational gotchas (per-group MCP config; multimodal slices; reactions inbound;
OPENAI_API_KEY path; pdftotext dependency; messages_in reaction-shape compatibility for compaction/agent-to-agent).

**Pick one of these next units** (in priority order)

## Option 1 (Recommended): Monday 2026-05-25 02:03 CEST — first live fire of §18

Cron task id = `task-1775472071448-rpvh6c`, in
`data/v2-sessions/ag-1779373702794-62oxsv/sess-1779373704595-mqteww/inbound.db`, recurrence `3 2 * * 1,4` (interpreted in
`Europe/Amsterdam`). DB `process_after = 2026-05-25T00:03:00Z`. **Next fire = Mon 2026-05-25 02:03 CEST = 00:03 UTC.**
Full test plan + failure modes in `p3-notes.md` §21. (Older docs incorrectly said "04:03 CEST" — that was off by 2 hours;
the DB UTC timestamp is the source of truth.)

After the cron has fired (any time after Mon 02:10 CEST, the report stays in-channel until someone interacts):

1. Open `#git-maintenance` in Slack. Confirm the Block Kit card rendered.
2. Verify `action_id`s start with `ncv2:` (NOT `nanoclaw_*` — that's failure mode A from §21.2).
3. Optionally tick a few checkboxes. Click "Confirm Delete". Confirm the agent acts on the pre-selected list.
4. Document outcome in `p3-notes.md` §22.

If no report appears on Monday morning:

- Check `logs/nanoclaw.log` for `[task-scheduler]` lines around 00:03 UTC (= 02:03 CEST).
- Sanity-check the cron is still scheduled with the snippet in §21.2 (D).
- Confirm `/health` returns 200 and `tasks.activeCount` > 0.

## Option 2: Voice / PDF / image / reaction live exercise

§20 ships unit tests but no end-to-end live verification. Quick wins:

- **Image:** Send any photo to your WhatsApp 1-on-1 with the bot. The agent should DESCRIBE the image (e.g. "I see a
  cat in a sunlit window") rather than just acknowledging the filename. If it just says "I see your photo," the multimodal
  block path isn't wiring.
- **Voice:** Send a voice note in WhatsApp. The agent should respond to the SPOKEN content. Confirm
  `logs/nanoclaw.log` shows a `Transcribed audio attachment` debug line.
- **PDF:** Drop a PDF in WhatsApp or Slack DM. The agent should respond to the document's CONTENT (e.g. summarise it).
  Confirm a `Extracted PDF text` debug line in the log.
- **Reaction:** React with 👍 to any of the agent's recent replies. Then send a follow-up message — the agent's prompt
  should now include `[John reacted 👍 on message <ts>]`. Confirm by tailing the agent-runner's stdout via
  `journalctl --user -u nanoclaw-v2-787facac.service` or pulling the relevant `inbound.db`.

If anything misfires, log it in `p3-notes.md` §22 alongside the §18 result.

## Option 3: `skipImageMultimodal` group config wiring (small, ~30 min)

§20.1 left this as a per-attachment `att.skipMultimodal=true` contract that the bridge doesn't set. To wire it from
group config:

1. Add `skipImageMultimodal?: boolean` to v2's group-config reader (search `src/group-init.ts` / `container-config.ts`
   for the v2 canonical reader).
2. In `chat-sdk-bridge.messageToInbound`, after building each image attachment entry, look up the destination group's
   `skipImageMultimodal` (the bridge currently routes by channel id → router decides group; you may need to set the
   flag on the attachment AFTER the router resolves the group, not inside the bridge).
3. Test: a group with `skipImageMultimodal=true` should still receive `[image: name — saved to ...]` text but the
   multimodal block must be suppressed.

Acceptance: `container/agent-runner/src/multimodal.test.ts` already covers `skipMultimodal=true`; add a host-side test
that the bridge stamps the flag based on group config.

## Option 4: W4.6 remote-control (~2-3 h, deferred)

V1's `src/remote-control.ts` (224 LOC) captures a `claude.ai/code` URL for ad-hoc remote access. Nice-to-have but not
load-bearing. Defer unless John wants ad-hoc remote claude access from his phone.

## Out of scope this session

- **Gmail channel re-install** — deferred (use the `/add-gmail` skill if it becomes needed).
- Anything in P5/P7/P8.
- Touching the systemd unit on the running install (`NRestarts=0` since restart; keep it green).

## Operational gotchas (carry into this session)

1. Canonical working tree is `/srv/apps/nanoclaw-v2`. Start the next session there.
2. Never restart v1's service (`nanoclaw.service`). Stopped+disabled.
3. `pnpm` at `~/.npm-global/bin/pnpm`, `onecli` same dir, `ncl` at `/srv/apps/nanoclaw-v2/bin/ncl` — prefix
   `PATH=…:$PATH` or use absolute paths.
4. v2's logs at `/srv/apps/nanoclaw-v2/logs/nanoclaw.{log,error.log}`, not journald.
5. v2 runs from `dist/`, not `src/`. `cd /srv/apps/nanoclaw-v2 && pnpm run build` (= tsc) is mandatory between any
   host-source edit and `systemctl --user restart`.
6. OneCLI gateway runs on `127.0.0.1:10255`. 10254 is the web UI.
7. `/health` reachable at `127.0.0.1:3002`. After `systemctl --user restart`, sleep ≥6s before curling.
8. `HOST_RESPONDER_COMMANDS` renderers run fire-and-forget off the hot path (W4.5 pattern). Render failures fall back
   to inline error messages — original inbound row already marked processed (no retry).
9. Mount allowlist after P3+W4.5: 3 allowedRoots + `~/.calendar-mcp`. 17 blockedPatterns.
10. v2 `additionalMounts` `containerPath` must be RELATIVE. v2 prefixes with `/workspace/extra/`.
11. DO NOT `git pull` on `/srv/apps/nanoclaw`. It's the v1 working tree.
12. Migration docs now live on v2's main at `docs/v2-migration/`. Edit there.
13. `writeOutboundDirect` now writes (fixed in `d8c04b8`).
14. v2 installer-template now writes `Type=notify` (fixed in `7cde667`).
15. Git author identity workaround: no `user.name`/`user.email` set anywhere visible. Use
    `git -c user.name="John Mathews" -c user.email="mthwsjc@gmail.com" commit ...` per-command override.
16. `v1-archive` branch is load-bearing for retire audits.
17. v2's provider interface is now multimodal-capable. `QueryInput.prompt` is still string-only;
    `AgentQuery.pushBlocks(ContentBlock[])` carries multimodal turns. `AgentProvider.supportsMultimodalContent` gates
    block construction in the poll-loop.
18. Bridge's `chat.onAction` filter order: `ncv2:` (W4.x-slack-interactivity) → `ncq:` (ask_user_question) → drop.
19. Image attachments delivered as base64 content blocks. Voice → Whisper-transcribed text in
    `attachment.transcription`. PDF → pdftotext output in `attachment.extractedText`. All inline-rendered by the
    formatter. Per-attachment `att.skipMultimodal=true` opts out of the image block path (text-only fallback).
20. Chat SDK `postMessage` can't carry raw Block Kit on Slack. v2's Slack channel casts into the private `WebClient`
    via a typed structural check (`src/channels/slack.ts` `makeSlackPostBlocks`). Brittle across `@chat-adapter/slack`
    version bumps — re-review on every bump.
21. Slack checkbox state isn't re-delivered with button clicks. Agents using checkbox+button pairs MUST persist the
    pre-selected option list in group memory keyed off the post timestamp and look it up at click time. Documented in
    `groups/slack_git-maintenance/CLAUDE.local.md`.
22. `ncv2:` is the v2-canonical Slack interactivity action_id prefix. Bridge's `chat.onAction` routes `ncv2:*` to the
    agent as a synthetic chat-sdk inbound (text + structured action payload). Anything not prefixed `ncv2:` or `ncq:`
    is silently dropped.
23. Git-maintenance cron task id = `task-1775472071448-rpvh6c`, in
    `data/v2-sessions/ag-1779373702794-62oxsv/sess-1779373704595-mqteww/inbound.db`. Recurrence `3 2 * * 1,4`. Next
    fire `2026-05-25T02:03:00Z`. First live test of §18 — plan in `p3-notes.md` §21.
24. `main` tracks `origin/main`. Bare `git push` goes to the fork; `git fetch upstream` still works.
25. `groups/*/CLAUDE.md` files are NOT tracked. `.gitignore` excludes `groups/*`. Never `git add` anything under
    `groups/`. Includes the §18 edits to `groups/slack_git-maintenance/CLAUDE.local.md`.
26. **Whisper transcription requires `OPENAI_API_KEY`.** Read from `process.env` first, then from `.env` via
    `readEnvFile`. The systemd unit doesn't `EnvironmentFile=.env`, so the file path is what serves in production.
    Test mocks must `vi.mock('./env.js', ...)` to avoid leaking the real key. Cached on first use; clear with
    `resetTranscriptionCacheForTests()`.
27. **PDF extraction requires `pdftotext` (poppler) on host `$PATH`.** Currently `/usr/bin/pdftotext` (poppler 25.03).
    Missing binary surfaces as `PdfExtractionError(kind=binary-missing)` and renders `PDF extraction failed: pdftotext
not installed` — the message still routes. 15s timeout, 50 MB input cap, 250 KB output cap (truncated silently).
28. **`messages_in` content shape includes reactions.** Code scanning inbound history (compaction, agent-to-agent
    return path) must tolerate `kind='chat-sdk'` rows where `content.reaction` is present and `content.text` is the
    synthetic `[X reacted Y on message Z]` line.

## Rollback recipes

- For §20 (multimodal + reactions): `git revert 0888c7f a12a111` + `pnpm run build` + `systemctl --user restart
nanoclaw-v2-787facac.service`. Container source is bind-mounted; no `./container/build.sh` needed. Net: drops back
  to pre-§20 behavior (image/voice/PDF dead-letter; reactions invisible to agent).
- For §18 (W4.x-slack-interactivity): `git revert 1142d0f 559d0c7` + rebuild + restart. The cron then breaks on next
  fire — but it would also have broken without §18.
- For the skill-output commits (b952767 / 1b21950): `git revert <sha>`, then `pnpm install` and `./container/build.sh`
  if reverting the container/Dockerfile commit. Reverting b952767 would also un-register the channel adapters and stop
  v2's live channels from initialising — almost certainly not what you want.
- For Task A topology: `git push --force-with-lease origin v1-archive:main` from any working tree with
  `johnmathews/nanoclaw` as a remote. Restores v1 main.
- For a service regression: `git checkout -- <files>`; `pnpm run build`; `systemctl --user restart
nanoclaw-v2-787facac.service`. Keep `NRestarts=0`.

## What to deliver this session

1. Whichever option(s) from §"Pick one of these next units" you tackled, with their per-section deliverables.
2. Tests pass (`cd /srv/apps/nanoclaw-v2 && pnpm test` — baseline is 39 files / 459 tests;
   `cd container/agent-runner && bun test` — baseline 10 files / 118 tests).
3. v2 healthy after any service-touching change (`curl http://127.0.0.1:3002/health` returns 200).
4. `project_v2_migration.md` memory updated with completed items + new operational gotchas.
5. `git push origin main` at end of session (tracking is sane — bare `git push` works).
6. End-of-session: produce a new next-session-prompt at `docs/v2-migration/next-session-prompt.md`.
