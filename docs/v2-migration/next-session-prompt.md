# Next-session prompt — continue NanoClaw v1→v2 migration after W4.7 + W4.x-multimodal + W4.x-reactions-inbound (§19 + §20)

Copy the block below (everything between the `---` lines) into a new Claude Code session in `/srv/apps/nanoclaw-v2` to
continue the migration. The prompt is self-contained — the new session won't see this conversation.

---

I'm continuing the NanoClaw v1→v2 migration. **State as of 2026-05-22 post-§20 + audit fixes:**
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
├── main                       ← HEAD = 49af3cc   (tracking origin/main)
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

**Required reading**, in this order (all paths inside `/srv/apps/nanoclaw-v2`):

    docs/v2-migration/operational-gotchas.md   Durable runtime knowledge — service paths, build steps,
                                               git topology, provider/multimodal/reactions wiring,
                                               Slack interactivity, scheduled tasks. Append new
                                               gotchas here as they surface; reference numbers are
                                               stable.
    docs/v2-migration/p3-notes.md              §19 W4.7 (journal MCP via per-group container.json,
                                               not env-var path); §20 W4.x-multimodal + reactions;
                                               §21 Monday 2026-05-25 02:03 CEST (= 00:03 UTC)
                                               live-verify plan for §18 git-maintenance cron.
    docs/v2-migration/implementation-plan.md   §5 P4 ordering: P4 effectively closed except W4.6.
    docs/v2-migration/fork-local-inventory.md  src/transcription.ts row flipped to re-ported.

Project memory at `~/.claude/projects/-srv-apps-nanoclaw/memory/project_v2_migration.md` is current as of 2026-05-22
post-§20. Items #40-#46 in its operational-gotchas section duplicate some of the entries in
`operational-gotchas.md` — that's fine; memory is for assistant continuity, the file is the operator-facing canonical
copy.

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

## Operational gotchas

Carry-over from past sessions. **Read `docs/v2-migration/operational-gotchas.md`** — durable runtime notes
(service paths, build steps, git topology, provider/multimodal/reactions wiring, Slack interactivity, scheduled
tasks). Append new gotchas to that file instead of letting them accumulate here; reference numbers are stable.

## Rollback recipes

- For post-§20 audit fixes: `git revert 49af3cc` (doc/test-only — no service impact). Drops back to the pre-audit
  state where §21 time was wrong and `maybeTranscribe`/`maybePdfExtract` had no dedicated tests.
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
2. Tests pass (`cd /srv/apps/nanoclaw-v2 && pnpm test` — baseline is 39 files / 465 tests;
   `cd container/agent-runner && bun test` — baseline 10 files / 118 tests).
3. v2 healthy after any service-touching change (`curl http://127.0.0.1:3002/health` returns 200).
4. `project_v2_migration.md` memory updated with completed items.
5. Any new runtime gotchas appended to `docs/v2-migration/operational-gotchas.md` (never renumber existing entries).
6. `git push origin main` at end of session (tracking is sane — bare `git push` works).
7. End-of-session: produce a new next-session-prompt at `docs/v2-migration/next-session-prompt.md`.
