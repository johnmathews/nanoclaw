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
  `docs/archive/v2-migration/p3-notes.md`, and recent commits before deleting.
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
12. Migration docs are archived at `docs/archive/v2-migration/` as of
    2026-05-28 (closure). `[migration-only — RETIRED 2026-05-28]`
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

## Delivery

31. Outbound delivery is **poll-driven**, and the WhatsApp socket
    reconnects ~150×/day, so the two interact. The host delivers via two
    polls (`src/delivery.ts`): the 1s active poll covers sessions whose
    `container_status` is `running`/`idle`; the 60s sweep covers all
    `active` sessions. A reply that can't send the instant it's written
    (WhatsApp mid-reconnect, or a "zombie" socket: `connection==='open'`
    but the server stopped acking) is **deferred** and re-driven later —
    but once the agent's turn ends the container idles/stops and the
    session leaves the fast poll, so the deferred reply used to wait for
    the 60s sweep (symptom: "ask → silence → user pokes the chat → reply
    appears instantly", because the new inbound re-wakes the container).
    Three mechanisms keep this prompt (added 2026-06-22, follow-up to the
    silent-loss fix `ef38c0f4` which removed WhatsApp's old
    flush-on-reconnect queue):
    - **`ChannelSetup.onReconnect`** (`src/channels/adapter.ts`) — WhatsApp
      fires it on every socket re-open *after the first*; the host runs
      `redriveActiveSessionsNow()` to flush deferred messages immediately.
    - **`pendingRedrive`** (`src/delivery.ts`) — a session with a
      non-terminal delivery (deferred in backoff, or mid transient-retry)
      stays on the 1s poll even off-container; cleared once everything is
      terminal so the set can't grow unbounded.
    - **`SEND_TIMEOUT_MS` = 15s** (`src/channels/whatsapp.ts`
      `sendViaSocket`) — caps a single `sock.sendMessage`; on timeout it
      tears the stale socket down (forcing a reconnect) and throws
      `ChannelDisconnectedError` so the host defers + re-drives, instead of
      hanging the session's inflight delivery forever.

## Responder behaviour (silent turns)

32. A turn can end having delivered **nothing** — the model returns empty
    text, or an `<internal>`-only body that strips to nothing. The host
    logs this as `Indexed conversation history … outCount=0`. For a *task*
    or *system* trigger that's often legitimate (delivered by email,
    posted mid-turn via `send_message`, or a reconnect ack like "Tools
    reconnected, no action needed"). For a **human chat message** it's a
    dropped reply — the user sees silence and has to poke the chat (`"?"`)
    to shake the reply loose. This is channel-agnostic (seen on nederlands
    WhatsApp, Financial Times, HackerNews, Managers' Guide, …); it just
    screamed loudest on the rapid-fire WhatsApp tutor. Fixed
    (added 2026-06-23) in the **container** agent-runner, not the host:
    - **Silent-turn recovery** (`container/agent-runner/src/poll-loop.ts`
      `processQuery`) — on every `result` event, if nothing reached the
      channel this turn (measured by the process-wide
      `getOutboundWriteCount()` in `db/messages-out.js`, which every
      delivery path — final `<message>` blocks + `send_message` /
      `send_file` / `edit_message` / `add_reaction` — increments) **and**
      the turn was triggered by a `chat`/`chat-sdk` message, push one
      `<system>` nudge asking the model to send its reply. Gated to chat
      triggers (tasks/digests stay silent), skipped while the wrapping
      retry already covers the turn, and capped at one nudge per silent run
      (`silentNudgeStreak`, re-armed on fresh input) so a model that means
      to stay silent can't be looped.
    - **Instruction reinforcement** (`mcp-tools/core.instructions.md`) —
      "Always reply to a user's chat message … stay silent only when a task
      explicitly tells you to."
    - **Deployment**: the agent-runner source is **bind-mounted live** from
      the host (`src/container-runner.ts` ~343:
      `container/agent-runner/src` → `/app/src`, read-only) — it is NOT
      baked into the image (the image's `/app` has no `src`). So a source
      edit needs **no image rebuild and no host restart**; it applies to the
      next container that *cold-starts*. A warm container keeps the old code
      in memory (Bun loads `index.ts` once at spawn) until it cycles — to
      force a live change immediately, kill the running container
      (`ncl groups restart`).
    - **Observed failure mode (2026-06-23):** the model often ends a chat
      turn with an `<internal>`-only body insisting it "already sent via
      send_message" — but the outbound log is empty (it never called the
      tool, or it answered an earlier message and conflated a newer one).
      The first, soft nudge ("you may stay silent") let it rationalize this
      as a "false alarm" and stay silent. The nudge was hardened to state
      factually that the outbound log is empty and to forbid an
      `<internal>`-only reply (when the nudge fires we *know*
      `deliveredThisTurn === 0`, so the assertion is always true).
    - Residual: the nudge fires **once** per silent run; if the model
      ignores even the hardened nudge the turn still ends silent (bounded,
      rare). The fix targets the manual-`"?"` symptom; it does not stop the
      model from producing an empty turn in the first place. Tests:
      `poll-loop.test.ts` "silent-turn recovery" (×4).
    - **Deeper fix (deferred — only if the nudge proves insufficient).**
      The nudge is a recovery band-aid; the root cause is the async
      multiplexing. nanoclaw batches inbound messages and `query.push()`es
      follow-ups into an already-running turn (`poll-loop.ts` ~433), so the
      model loses the clean "this input needs exactly one reply" framing
      that Claude Code gets for free — it answers message N, message N+1 is
      folded into the same query, and it thinks N+1 is "already handled"
      ("already sent via send_message — false alarm"). The real fix is to
      bind each inbound `chat`/`chat-sdk` row to a *required* delivery and
      not let a follow-up silently absorb an unanswered message — e.g. track
      unanswered chat rows per turn and only clear a row once a delivery
      addressed to its channel/sender lands, otherwise re-prompt
      specifically for the unanswered message. Bigger change to the batching
      model than the nudge; do this only if the hardened nudge still leaks.

33. **Silent-turn nudge fired on task ticks that followed a chat**
    (fixed 2026-07-02, `container/agent-runner/src/poll-loop.ts`). The nudge
    (item 32) is gated on a `turnExpectsReply` flag. That flag was **set
    only, never cleared** — the initial chat batch latched it to `true` and
    it stayed true for the rest of the `processQuery` run. So when a
    scheduled task fired *later* in the same run (a follow-up `query.push()`
    into the still-open query, `poll-loop.ts` ~433) and ended silently — as
    routine-success tasks are documented to — the nudge still fired and
    forced the background task to emit an extra channel message, violating
    the "silent on routine success" task contract. Fix: rebind the flag to
    the current follow-up batch instead of latching —
    `turnExpectsReply = expectsReply(keep)` (was
    `if (expectsReply(keep)) turnExpectsReply = true`). A chat follow-up sets
    it true, a task-only follow-up sets it false. `initialExpectsReply` and
    the `expectsReply` predicate are untouched. Tradeoff (rare, not
    addressed): if a task follow-up lands *before* an as-yet-undelivered
    chat's turn-end fires, the flag clears and that chat's silent-turn nudge
    is suppressed — in practice the chat's end-of-turn fires first. Regression
    test: `poll-loop.test.ts` "does not nudge a task follow-up that lands
    after a completed chat turn" (silent-turn recovery block is now ×5).
    Deploys on the next container cold-start via the live bind-mount (item
    32 "Deployment") — no image rebuild or host restart required.

34. **Container test suite was red on every code PR for ~3 weeks — one test
    file leaked a signalless poll loop** (fixed 2026-07-14, PR #738,
    `container/agent-runner/src/upload-trace.test.ts`). The full `bun test`
    run failed deterministically on two *unrelated* tests
    (`integration.test.ts` "/clear arrives as a follow-up" and
    `poll-loop.test.ts` "silent-turn … does not nudge a task follow-up"),
    both of which pass in isolation. Root cause: `upload-trace.test.ts`'s
    local `runPollLoopWithTimeout` helper called `runPollLoop({...})`
    **without `signal`** — unlike the identical helper in
    `integration.test.ts`. With no signal, `runPollLoop`'s
    `config.signal?.aborted` check never fires, so `controller.abort()` only
    settled the wrapping `Promise.race` while the underlying loop **ran
    forever**, polling the shared global session DB every second into every
    later test file, `markProcessing`-ing (stealing) their pending messages
    and throwing `unable to open database file` after each `closeSessionDb()`.
    This is exactly what the `PollLoopConfig.signal` doc comment warns about.
    Fix = one line: thread `signal` through (no prod change — prod never
    passes a signal). Debugging lesson: treat "flaky" full-suite-only
    failures as **deterministic cross-file pollution** and bisect with
    explicit file args (`bun test A.test.ts B.test.ts`) to find the polluter,
    rather than bumping timeouts. Verified with 16 consecutive green full-suite
    runs (164→165 pass / 0 fail). A separate, genuinely-flaky test
    (`search_history` fixed-`sleep(50)` race) was deflaked the same day in
    PR #736 (poll-until-present).

35. **Restarting the host re-reads `.env`; a truncated or root-owned `.env`
    silently drops Slack + the OneCLI host client** (incident + recovery
    2026-07-14). The host runs compiled `dist/`
    (`ExecStart=/usr/bin/node .../dist/index.js`) and reads secrets from
    `.env` via `readEnvFile` at process start. On 2026-07-14 a routine
    restart (to deploy host `src/` changes) surfaced that `.env` had been
    **truncated and chowned to `root:600` on 2026-07-12** — `SLACK_SIGNING_SECRET`,
    `ONECLI_URL`, `ONECLI_API_KEY` were gone. The 11-day-old process held the
    full set in memory, so nothing broke until the restart. Consequences:
    Slack loaded its token then threw `signingSecret is required`; the OneCLI
    host SDK (`new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY })` in
    `container-runner.ts`) fell back to cloud `api.onecli.sh` and 401'd on
    every `wakeContainer` (766 times — noisy but non-fatal; containers still
    spawn, they get creds via the *local* proxy at request time). WhatsApp
    survived (file-based auth in a separate dir). **Recovery:** `.env` must be
    `john`-owned and readable (`sudo chown john:john .env` — run in a real
    terminal, NOT via a tool `!` prefix, which can't answer the sudo password
    prompt); add `ONECLI_URL=http://172.17.0.1:10254` (the local proxy from
    `~/.onecli/config.json`; it needs no auth so `ONECLI_API_KEY` can stay
    unset); restore `SLACK_SIGNING_SECRET` from api.slack.com (app → Basic
    Information → Signing Secret; `SLACK_APP_TOKEN` in `.env` is unused — the
    adapter is HTTP-mode, not socket-mode). **Deploy = `pnpm run build` then
    `systemctl --user restart nanoclaw-583cc1c4`** (host `src/` only — container
    `src/` needs neither, per item 32). **Before any host restart, diff needed
    vs present env keys** — `grep -rhoE "readEnvFile\(\[[^]]*\]" src/` gives the
    needed set. For this install only two of the "missing" keys ever matter
    (`ONECLI_URL`, `SLACK_SIGNING_SECRET`); `RESEND_*` (0 wired channels),
    `WHATSAPP_*` (WA works without), `TZ` (system is `Europe/Amsterdam`), and
    `ANTHROPIC_BASE_URL` are optional/unused here.
