# Operational gotchas — NanoClaw v2 (this fork)

**Status:** living — append-only runtime gotchas log for the v2 codebase. **Last verified:** 2026-11-06, every entry against `dfaabc34` (v2026.10.0) and the live install on agent_lxc (unit, ports, `.env` keys, allowlist, logs). Reference numbers are stable across edits.

Since the 2026-11-05 cutover to v2026.10.0, standing decisions for this install
live in `CLAUDE.md` § "This install — fork conventions" (default model, upgrade
stamp, OneCLI pin, Slack HTTP mode, …). This file keeps the runtime traps and
the history behind them.

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
  `.nanoclaw-migrations/`, and recent commits before deleting.
- If a gotcha graduates into stable, well-documented behavior, move the
  authoritative text into the relevant doc (`CLAUDE.md` § "This install —
  fork conventions", `docs/agent-runner-details.md`, etc.) and leave a short
  pointer here. (`docs/SPEC.md` is the historical v1 spec, so it is not a
  destination.)

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
3. Tool locations (verified 2026-11-06): `pnpm` is `/usr/bin/pnpm`
   (corepack; `~/.npm-global/bin/pnpm` also exists), `onecli` is
   `~/.local/bin/onecli`, `ncl` is `~/.local/bin/ncl` → `/srv/apps/nanoclaw/bin/ncl`.
   The unit's `PATH` includes `~/.local/bin`; an interactive or tool shell
   may not, so use absolute paths there.
4. v2's logs at `/srv/apps/nanoclaw/logs/nanoclaw.{log,error.log}`, not
   journald. Unit redirects via `StandardOutput=append:`. journalctl only
   shows the systemd start message. Lines carry no date (`CLAUDE.md`
   convention 10), and nothing rotates them: `nanoclaw.error.log` was
   2.7 GB on 2026-11-06.
5. v2 runs from `dist/`, not `src/`. `cd /srv/apps/nanoclaw && pnpm run build`
   (= tsc) is mandatory between any host-source edit and
   `systemctl --user restart nanoclaw-583cc1c4`. Pre-W4.3 muscle memory from
   v1 (tsx) will skip this. Since v2026.10.0 every commit also needs
   `pnpm exec tsx scripts/upgrade-state.ts set` before the next restart, or
   the service refuses to boot (`CLAUDE.md` convention 7).
6. OneCLI listens on two ports, each bound to `127.0.0.1` and the docker0
   address `172.17.0.1`: **10255** is the credential-injecting gateway proxy
   (the one `docs/onecli-upgrades.md`'s probe tests), **10254** is the web UI
   and API (`ONECLI_URL` in `.env`, `api-host` in `~/.onecli/config.json`).
7. `/health` reachable at `127.0.0.1:3002`. After `systemctl --user restart`,
   sleep ≥6s before curling — channels connect first, health server second.
   Its `channels` list only shows adapters that started: a channel missing
   from it is not running (see item 37).

## Command + responder behaviour

8. `HOST_RESPONDER_COMMANDS` (`src/command-gate.ts`) renderers run
   fire-and-forget off the hot path (W4.5 pattern). Render failures fall back
   to inline error messages — the original inbound row is already marked
   processed (no retry).
9. Mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`, verified
   2026-11-06): 4 `allowedRoots` — `/srv/apps/nanoclaw`, `~/.gmail-mcp`,
   `~/.calendar-mcp`, and the paywall extension
   `/srv/apps/syncthing/all/bypass-paywalls-chrome-clean-master`, which **no
   longer exists** (item 38). The file's own `blockedPatterns` is empty; the
   loader merges 19 defaults from `src/modules/mount-security/index.ts`
   (17 before v2026.10.0). Its top-level `nonMainReadOnly` key is ignored
   and logs a WARN at every load: read-only is per root now.
10. v2 `additionalMounts` `containerPath` must be RELATIVE. v2 prefixes
    with `/workspace/extra/`. v1-style absolute paths are rejected.

## Git topology

11. ~~DO NOT `git pull` on `/srv/apps/nanoclaw`; it's the v1 working
    tree.~~ `[migration-only — RETIRED]` `/srv/apps/nanoclaw` is the v2 `main`,
    tracking `origin/main`, and is where this install's commits and merges
    are made (the v2026.10.0 merge, 2026-11-06). Pulling is fine; what bites
    is restarting after any commit or pull without the upgrade stamp (item 5).
12. ~~Migration docs are archived at `docs/archive/v2-migration/`.~~
    `[migration-only — RETIRED]` No `docs/archive/` exists. Migration records
    live in `.nanoclaw-migrations/` (`index.md`, closed 2026-11-05;
    `index-2026-06-15-executed.md` for the June rebuild).
13. `writeOutboundDirect` now writes (fixed in `d8c04b8`; the function is in
    `src/session-manager.ts` since v2026.10.0). Before that fix, every deny /
    respond / respond-error path in `src/router.ts` silently failed because
    the function opened the outbound DB readonly.
14. v2 installer-template now writes `Type=notify` (fixed in `7cde667`).
    Fresh-install-only — the live unit already had the W4.3 hand-edited
    flags.
15. ~~Git author identity workaround: no `user.name` / `user.email` set.~~
    `[RETIRED]` As of 2026-11-06 the global git config on agent_lxc sets the
    author, so plain `git commit` works.
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
    click time. (It was documented in
    `groups/slack_git-maintenance/CLAUDE.local.md`; that group no longer
    exists on this install, so this entry is now the only record.)
28. `ncv2:` is the v2-canonical Slack interactivity `action_id` prefix.
    Bridge's `chat.onAction` routes `ncv2:*` to the agent as a synthetic
    chat-sdk inbound (text + structured action payload). Anything not
    prefixed `ncv2:` or `ncq:` is silently dropped.

## Scheduled tasks

29. ~~Git-maintenance cron task id = `task-1775472071448-rpvh6c` …~~
    `[time-sensitive — RETIRED]` The 2026-05-25 fire it tracked has passed
    and the git-maintenance group is gone. Recurrences are still interpreted
    in `TIMEZONE` (`src/config.ts`; system zone `Europe/Amsterdam`), now via
    `src/modules/scheduling/create.ts`.

## Docs

30. `docs/agent-runner-details.md` was rewritten post-audit (commit
    `49af3cc`) to match the post-§18 + §20 provider interface. Source
    of truth is still `container/agent-runner/src/providers/types.ts` +
    `multimodal.ts` + `src/transcription.ts` / `src/pdf-extract.ts` —
    the doc mirrors them. If interfaces drift again, fix the doc here
    rather than letting it stale.

## Delivery

31. > **As of v2026.10.0 (2026-11-05) the three mechanisms below are not in
    > the code** — `onReconnect`, `pendingRedrive` and `SEND_TIMEOUT_MS` are
    > absent from `src/`. Upstream's `src/delivery.ts` now defers a send to an
    > offline channel with backoff and re-drives it, and adapters signal
    > "offline" by throwing `ChannelDisconnectedError` (ported
    > `src/channels/delivery-errors.ts`). The WhatsApp prompt-delivery fix
    > (`2c7f6245`) was marked PORT in `.nanoclaw-migrations/08-deep-intents.md`
    > §8.2 item 6 but was not re-applied. It is moot while WhatsApp is
    > unpaired (item 37); re-check §8.2 before pairing it again. The text
    > below is the June history.

    Outbound delivery is **poll-driven**, and the WhatsApp socket
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

32. > **As of v2026.10.0 the recovery is re-implemented on upstream's turn
    > model** (`.nanoclaw-migrations/08-deep-intents.md` §8.1). Same behaviour
    > and the same hardened nudge text, different internals:
    > `container/agent-runner/src/poll-loop.ts` `processQuery` keeps a
    > per-turn `silentNudged` flag on each `QueuedTurn` (replacing
    > `silentNudgeStreak`), and "nothing delivered" is
    > `midTurnSent === 0 && !chatRowWrittenSince(turnStartSeq)`, read from the
    > outbound DB (replacing `getOutboundWriteCount()`). Tests:
    > `poll-loop.silent-turn.test.ts`. The bind-mount deployment note below
    > still holds (`src/container-runner.ts` ~1188, read-only `/app/src`).
    > Line numbers and names in the text below are from June.

    A turn can end having delivered **nothing** — the model returns empty
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

33. > **As of v2026.10.0 this bug cannot recur:** routing (and the nudge
    > guard) is rebound per turn, so a task tick never inherits a chat
    > turn's state. There is no `turnExpectsReply` flag any more; the gate is
    > `routing.expectsReply`. Kept for the history.

    **Silent-turn nudge fired on task ticks that followed a chat**
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
    **Cause, found 2026-08-24:** the home-server Ansible role (`make agent`)
    templated `.env` from a v1-era template as `root:600`. The role no longer
    touches `.env` (home-server `documentation/agent.md` § "NanoClaw `.env` is
    hand-managed"). Verified 2026-11-06: `.env` is `john:john 600` and holds
    `ONECLI_URL` and `SLACK_SIGNING_SECRET`. The key list from the grep above
    now also includes `NANOCLAW_GATEWAY_PROVIDER` (set here; `onecli`) and
    `SLACK_INSTANCES` (unset; optional).

36. **NanoClaw's Claude login is a OneCLI secret, not `~/.claude`.** Agent
    containers authenticate with a `claude setup-token` token stored in the
    OneCLI vault as the secret "Anthropic"; OneCLI injects it on each
    request. `claude login` on the host only rewrites `~/.claude`, which
    serves interactive `claude` and `/usage`, so it does not fix a NanoClaw
    401 outage (2026-10-26/27, ~22 h). Renewal runbook and the Grafana alert
    that watches OneCLI's 401s: home-server `documentation/agent.md`
    § "Claude login (OneCLI token)". Added 2026-11-06.

37. **WhatsApp has been unpaired since 2026-08-02.** The last WhatsApp
    delivery in the log is 2026-08-01 17:00 CEST. `store/auth/` has been empty
    since 2026-08-02 07:10 CEST (its mtime), which matches the adapter's
    logged-out path (`classifyConnectionClose` → `'wipe'` →
    `rmSync` + `mkdirSync` in `src/channels/whatsapp.ts`; inferred, the log
    line itself was not found). Nothing re-paired it. With no
    `store/auth/creds.json`, `WHATSAPP_PHONE_NUMBER` or `WHATSAPP_ENABLED`,
    the adapter factory returns `null`, so WhatsApp does not start at all:
    startup logs only `cli` and `slack`, and `/health` lists only those.
    Nothing alerts on this. The `whatsapp_main` group and one `whatsapp`
    messaging group are still wired. To bring it back, pair again
    (`/add-whatsapp`) after re-checking item 31's note. Found 2026-11-06.

38. **The paywall extension mount points at a deleted directory.** The
    Financial Times and HackerNews Summaries groups mount
    `/srv/apps/syncthing/all/bypass-paywalls-chrome-clean-master` as `bpc`
    (`docs/research-paywall-browser.md`). Syncthing and that directory were
    removed from agent_lxc on 2026-10-23. Every spawn of those groups now logs
    `WARN Additional mount REJECTED … Host path does not exist`, in
    `logs/nanoclaw.error.log`, not `nanoclaw.log`. The container still starts,
    just without the extension, so paywalled fetches quietly lose the bypass.
    The fix is a new home for the extension, plus updates to the allowlist
    root (item 9) and both groups' `additional_mounts`. Found 2026-11-06.
