# Operational gotchas — NanoClaw v2 (this fork)

**Status:** living — append-only runtime gotchas log for the v2 codebase. **Last updated:** 2026-05-28. Reference numbers are stable across edits.

Durable runtime notes about the v2 install. Carry-over from past sessions;
append new entries here rather than letting them accumulate in
session-specific prompts. The next-session prompts reference this file as
required reading instead of duplicating the list.

**How to maintain:**

- **Append** new gotchas at the bottom. Never renumber existing entries —
  past commit messages and prompts reference them by number.
- **Update** an existing entry in place when behavior changes, but keep the
  number. Mark superseded sub-points clearly (e.g. "as of `<commit>`,
  this changed to …").
- **Delete** an entry only when the underlying behavior has been retired
  AND no in-flight migration step depends on it. Cross-check `journal/`,
  `docs/v2-migration/p3-notes.md`, and recent commits before deleting.
- If a gotcha graduates into stable, well-documented behavior, move the
  authoritative text into the relevant doc (`docs/SPEC.md`,
  `docs/agent-runner-details.md`, etc.) and leave a short pointer here.

Most entries are v2-runtime concerns; some are migration-era topology
notes that will retire once v1 is tombstoned (W8.6). Mark migration-only
entries with `[migration-only]` so they're easy to prune later.

## Service + working tree

1. Canonical working tree is `/srv/apps/nanoclaw`. Start every session
   there. (Pre-2026-05-25 this was `/srv/apps/nanoclaw-v2` — the rename
   happened when v1 was deleted; see
   `journal/260525-remove-v1-and-drop-v2-suffix.md`.)
2. ~~Never restart v1's service.~~ v1 has been deleted as of 2026-05-25.
   Only artefact is the `v1-archive` git branch on the fork.
   `[migration-only — RETIRED 2026-05-25]`
3. `pnpm` at `~/.npm-global/bin/pnpm`, `onecli` at the same dir, `ncl` at
   `/srv/apps/nanoclaw/bin/ncl` — prefix `PATH=…:$PATH` or use absolute
   paths. These are not on Claude Code's Bash tool default PATH.
4. v2's logs at `/srv/apps/nanoclaw/logs/nanoclaw.{log,error.log}`, not
   journald. Unit redirects via `StandardOutput=append:`. journalctl only
   shows the systemd start message.
5. v2 runs from `dist/`, not `src/`. `cd /srv/apps/nanoclaw && pnpm run build`
   (= tsc) is mandatory between any host-source edit and
   `systemctl --user restart`. Pre-W4.3 muscle memory from v1 (tsx)
   will skip this.
6. OneCLI gateway runs on `127.0.0.1:10255`. 10254 is the web UI.
7. `/health` reachable at `127.0.0.1:3002`. After `systemctl --user restart`,
   sleep ≥6s before curling — channels connect first, health server second.

## Command + responder behaviour

8. `HOST_RESPONDER_COMMANDS` renderers run fire-and-forget off the hot path
   (W4.5 pattern). Render failures fall back to inline error messages —
   the original inbound row is already marked processed (no retry).
9. Mount allowlist after P3 + W4.5: 3 `allowedRoots` + `~/.calendar-mcp`.
   17 `blockedPatterns`.
10. v2 `additionalMounts` `containerPath` must be RELATIVE. v2 prefixes
    with `/workspace/extra/`. v1-style absolute paths are rejected.

## Git topology

11. DO NOT `git pull` on `/srv/apps/nanoclaw`. It's the v1 working tree;
    its local main = `0bd42bb` and diverges from remote main.
    `[migration-only]`
12. Migration docs now live on v2's main at `docs/v2-migration/`. Edit
    there, not on the v1 working tree.
13. `writeOutboundDirect` now writes (fixed in `d8c04b8`). Before that
    fix, every deny / respond / respond-error path in `src/router.ts`
    silently failed because the function opened the outbound DB readonly.
14. v2 installer-template now writes `Type=notify` (fixed in `7cde667`).
    Fresh-install-only — the live unit already had the W4.3 hand-edited
    flags.
15. Git author identity workaround: no `user.name` / `user.email` set
    anywhere visible. Use
    `git -c user.name="John Mathews" -c user.email="mthwsjc@gmail.com" commit ...`
    per-command override.
16. `v1-archive` branch is load-bearing for retire audits. When v2
    retires a v1 file, audit reads should still target `v1-archive` (or
    the v1 working tree while it exists), not v2 main.
17. `main` tracks `origin/main`. Bare `git push` goes to the fork
    (`johnmathews/nanoclaw`); `git fetch upstream` still pulls from
    `nanocoai/nanoclaw`.
18. `groups/*/CLAUDE.md` files are NOT tracked. `.gitignore` excludes
    `groups/*`. Never `git add` anything under `groups/`. Includes the
    §18 edits to `groups/slack_git-maintenance/CLAUDE.local.md`.

## Provider + multimodal + reactions

19. v2's provider interface is now multimodal-capable. `QueryInput.prompt`
    is still string-only; `AgentQuery.pushBlocks(ContentBlock[])` carries
    multimodal turns. `AgentProvider.supportsMultimodalContent` gates
    block construction in the poll-loop.
20. Image attachments are delivered as base64 content blocks. Voice →
    Whisper-transcribed text in `attachment.transcription`. PDF →
    pdftotext output in `attachment.extractedText`. All inline-rendered
    by the formatter. Per-attachment `att.skipMultimodal=true` opts out
    of the image block path (text-only fallback).
21. **Whisper transcription requires `OPENAI_API_KEY`.** Read from
    `process.env` first, then from `.env` via `readEnvFile`. The systemd
    unit doesn't `EnvironmentFile=.env`, so the file path is what serves
    in production. Test mocks must `vi.mock('./env.js', …)` to avoid
    leaking the real key. Cached on first use; clear with
    `resetTranscriptionCacheForTests()`.
22. **PDF extraction requires `pdftotext` (poppler) on host `$PATH`.**
    Currently `/usr/bin/pdftotext` (poppler 25.03). Missing binary
    surfaces as `PdfExtractionError(kind=binary-missing)` and renders
    `PDF extraction failed: pdftotext not installed` — the message still
    routes. 15 s timeout, 50 MB input cap, 250 KB output cap (truncated
    silently).
23. **`messages_in` content shape includes reactions.** Code scanning
    inbound history (compaction, agent-to-agent return path) must
    tolerate `kind='chat-sdk'` rows where `content.reaction` is present
    and `content.text` is the synthetic
    `[X reacted Y on message Z]` line.
24. **`maybeTranscribe` / `maybePdfExtract` are exported from
    `src/channels/chat-sdk-bridge.ts`** so tests can exercise them in
    isolation. They're thin wrappers around `transcribeAudio` /
    `extractPdfText` — mime guard → underlying call → mutate
    `entry.transcription` / `extractedText` on success,
    `entry.transcriptionError` / `pdfExtractionError` on failure.
    `messageToInbound` invokes them sequentially per attachment after
    `att.fetchData()`. Worst case is a multi-PDF message blocking the
    bridge handler for ~15 s × n; same as v1. If chat-platform timeouts
    surface, fan out via `Promise.all` per attachment + a per-message
    overall cap.

## Slack interactivity

25. Bridge's `chat.onAction` filter order: `ncv2:`
    (W4.x-slack-interactivity) → `ncq:` (`ask_user_question`) → drop.
26. Chat SDK `postMessage` can't carry raw Block Kit on Slack. v2's
    Slack channel casts into the private `WebClient` via a typed
    structural check (`src/channels/slack.ts` `makeSlackPostBlocks`).
    Brittle across `@chat-adapter/slack` version bumps — re-review on
    every bump.
27. Slack checkbox state isn't re-delivered with button clicks. Agents
    using checkbox+button pairs MUST persist the pre-selected option
    list in group memory keyed off the post timestamp and look it up at
    click time. Documented in
    `groups/slack_git-maintenance/CLAUDE.local.md`.
28. `ncv2:` is the v2-canonical Slack interactivity `action_id` prefix.
    Bridge's `chat.onAction` routes `ncv2:*` to the agent as a synthetic
    chat-sdk inbound (text + structured action payload). Anything not
    prefixed `ncv2:` or `ncq:` is silently dropped.

## Scheduled tasks

29. Git-maintenance cron task id = `task-1775472071448-rpvh6c`, in
    `data/v2-sessions/ag-1779373702794-62oxsv/sess-1779373704595-mqteww/inbound.db`.
    Recurrence `3 2 * * 1,4` interpreted in `Europe/Amsterdam`
    (`src/modules/scheduling/recurrence.ts:31`). Next fire
    `2026-05-25T00:03:00Z = 02:03 CEST`. First live test of §18 — plan
    in `p3-notes.md` §21. `[time-sensitive — retires after Mon 2026-05-25 fire]`

## Docs

30. `docs/agent-runner-details.md` was rewritten post-audit (commit
    `49af3cc`) to match the post-§18 + §20 provider interface. Source
    of truth is still `container/agent-runner/src/providers/types.ts` +
    `multimodal.ts` + `src/transcription.ts` / `src/pdf-extract.ts` —
    the doc mirrors them. If interfaces drift again, fix the doc here
    rather than letting it stale.
