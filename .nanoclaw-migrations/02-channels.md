# Section 02 — Channels

Channel adapters are NOT in upstream trunk — they live on the `channels` branch and are
installed by `/add-<channel>` skills (copy files + append a self-registration import to
`src/channels/index.ts` + `pnpm install` a pinned dep). On clean upstream these files
DON'T EXIST until re-installed.

**Step 1 — re-install (in this order):** `/add-whatsapp`, then `/add-slack`, then
`/add-resend`. The skills append their own imports to `src/channels/index.ts` (final order:
whatsapp, slack, resend) and add pinned deps. Pinned versions the fork used (the skills set
these; listed for reference): `@chat-adapter/slack@4.26.0`, `@resend/chat-sdk-adapter@0.1.1`,
`@whiskeysockets/baileys@7.0.0-rc.9`, `pino@9.6.0`, `qrcode@1.5.4`, `@types/qrcode@1.5.6`.
(`@whiskeysockets/baileys` is an rc — check npm release date when pinning.)

**Step 2 — re-apply the fork's modifications below.** Resend is **pristine** (no mods).

> Recover any verbatim block with `git show 971239a:<path>` or
> `git diff upstream/channels..971239a -- <path>` (the channels branch is `upstream/channels`).

---

## 2.1 chat-sdk-bridge — multimodal, reactions, Block Kit/card delivery, approval byline

**Origin:** fork-original (modifies the channels-branch file). **Commits:** `0888c7f`
(multimodal+reactions), `1142d0f` (slack interactivity / ncv2:), `49af3cc` (audit drift),
`971239a` (approval-card byline — already cherry-picked onto current HEAD).

**Files:** `src/channels/chat-sdk-bridge.ts`, `chat-sdk-bridge.test.ts`,
`chat-sdk-bridge-byline.test.ts` (net-new file).

Apply (after `/add-slack`): apply `git diff upstream/channels..971239a -- src/channels/chat-sdk-bridge.ts`.
Key additions:
1. Add `LinkButton`, `CardChild` to the `chat` package import block.
2. Add `import { isPdfMime, extractPdfText, PdfExtractionError } from '../pdf-extract.js';`
   and `import { isTranscribableMime, transcribeAudio, TranscriptionError } from '../transcription.js';`
   (those host modules are ported in §03).
3. Add interfaces `PostBlocksResult`, `PostBlocksFn`, `Ncv2InboundInput`, `ReactionInboundInput`
   and exported functions `buildNcv2Inbound`, `buildReactionInbound`, `maybeTranscribe`,
   `maybePdfExtract`.
4. Add `postBlocks?: PostBlocksFn` to `ChatSdkBridgeConfig`.
5. Delivery branches: `content.type === 'blocks'` → call `config.postBlocks` (fallback to
   `fallbackText`); `content.type === 'card'` → build a Chat SDK `Card` (title, description,
   string children, optional `LinkButton` actions for URL-bearing actions).
6. `chat.onReaction` handler → `buildReactionInbound` → `onInbound`.
7. `chat.onAction` `ncv2:` prefix branch → `buildNcv2Inbound` → `onInbound`.
8. In the approval-card `onAction` (`ncq:` prefix) handler, after editing the card markdown
   append the actor byline ` — ${actor.userName ?? actor.fullName}` when present (this is the
   `971239a` change — already on HEAD).

Tests: add the new suites to `chat-sdk-bridge.test.ts` (send_card display, `buildNcv2Inbound`,
`maybeTranscribe`/`maybePdfExtract`; mock `../env.js`, isolate `OPENAI_API_KEY`, import
`resetTranscriptionCacheForTests`). Create `chat-sdk-bridge-byline.test.ts` verbatim (drives the
real `onAction` via `chat.processAction` to assert the byline; imports `initTestDb`,
`runMigrations`, `closeDb` from `../db/index.js`).

**Depends on:** `src/pdf-extract.ts`, `src/transcription.ts` (§03, port first);
`resetTranscriptionCacheForTests` exported from `transcription.ts`; `LinkButton`/`CardChild`
available from the pinned `chat`/`@chat-adapter/slack` version.

---

## 2.2 Slack — `send_blocks` Block Kit passthrough + `postBlocks` wiring

**Origin:** fork-original. **Commits:** `b952767` (bundle adapters), `1142d0f` (slack interactivity).
**File:** `src/channels/slack.ts`.

Apply (after `/add-slack`, alongside §2.1):
1. Imports: add `import { log } from '../log.js';` and change the bridge import to
   `import { createChatSdkBridge, type PostBlocksFn } from './chat-sdk-bridge.js';`.
2. Before `registerChannelAdapter`, add `interface SlackWebClient { chat: { postMessage(args:{
   channel:string; thread_ts?:string; text:string; blocks?:unknown[]; unfurl_links?:boolean;
   unfurl_media?:boolean }): Promise<{ ok?:boolean; ts?:string; channel?:string; error?:string }> } }`
   and `function makeSlackPostBlocks(slackAdapter: unknown): PostBlocksFn | null` which reaches
   into the adapter's private `.client.chat.postMessage` (returns null + warns if absent),
   parses the `slack:CHANNEL[:thread_ts]` threadId, posts verbatim blocks with
   `unfurl_links:false, unfurl_media:false`, throws on `!result.ok`, returns `{ id: result.ts }`.
   (Full body: `git show 971239a:src/channels/slack.ts`.)
3. In the factory, change the bridge construction to:
   ```ts
   const postBlocks = makeSlackPostBlocks(slackAdapter) ?? undefined;
   const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true, postBlocks });
   ```

**Depends on:** §2.1 (`PostBlocksFn`/`postBlocks` config).

---

## 2.3 WhatsApp — inbound attachment spill (base64/inbox) + safer shutdown + Baileys v7

**Origin:** fork-original. **Commits:** `deb0b31` (attachment spill), `3603e24` (mention parsing
+ safer shutdown/logout). **Files:** `src/channels/whatsapp.ts`, `whatsapp.test.ts`.

Intent: upstream channels-branch `downloadInboundMedia` writes attachments to host
`data/attachments/` and returns `localPath` the container can't see. The fork (1) returns
bytes as base64 `data` so `session-manager.extractAttachmentFiles` spills them to
`<sessionDir>/inbox/` (container-readable); (2) adds `mimeType` + `size`; (3) hoists the
function out of the `registerChannelAdapter` closure (module-level, injectable `download` param
for tests); (4) adds `maybeTranscribe`/`maybePdfExtract` hooks for inline voice/PDF; (5) adds
`classifyConnectionClose` so the auth-wipe-on-graceful-shutdown regression is testable.

Apply (after `/add-whatsapp`): apply `git diff upstream/channels..971239a -- src/channels/whatsapp.ts`.
Key points:
1. Drop `DATA_DIR` from the config import (`import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME }
   from '../config.js';`).
2. Add `import { maybePdfExtract, maybeTranscribe } from './chat-sdk-bridge.js';`.
3. Add exported `classifyConnectionClose(reason, shuttingDown): 'reconnect'|'wipe'|'preserve'`:
   ```ts
   if (reason === DisconnectReason.loggedOut) return 'wipe';
   if (shuttingDown) return 'preserve';
   return 'reconnect';
   ```
   Wire it into the connection-close handler so graceful shutdown PRESERVES auth (the historical
   bug wiped creds on shutdown — see memory `project_wa_multimodal_and_shutdown_fix`).
4. Add `WhatsAppInboundAttachment` type + `INBOUND_MEDIA_TYPES` const; replace the closure
   `downloadInboundMedia` with the module-level exported version returning base64 `data` +
   `mimeType` + `size`, calling `maybeTranscribe`/`maybePdfExtract`.
5. Replace `whatsapp.test.ts` entirely (covers `downloadInboundMedia` base64 / no-disk-write /
   transcription error path, and `classifyConnectionClose`; mocks `readEnvFile`, imports
   `DisconnectReason` from `@whiskeysockets/baileys` and `resetTranscriptionCacheForTests`).

**Baileys v7 auth (`setup/whatsapp-auth.ts`)** — commit `b952767`. The `/add-whatsapp` skill
installs a channels-branch version; then apply the fork's `resolveWaWebVersion()` change: remove
the `createRequire` import + v6 `getPlatformId` charCode monkey-patch (Baileys 7 fixed it); add
async `resolveWaWebVersion()` that checks the wppconnect.io version tracker first, falls back to
Baileys `fetchLatestWaWebVersion`, and THROWS if both fail (prevents auth with a stale WA Web
version); replace the `fetchLatestWaWebVersion({}).catch(...)` call with `await resolveWaWebVersion()`.

**Depends on:** §2.1 (`maybeTranscribe`/`maybePdfExtract` live in chat-sdk-bridge.ts — land that
first); `src/transcription.ts` exporting `resetTranscriptionCacheForTests`.

**Also:** `setup/groups.ts` (new file, commit `b952767`) — WhatsApp group-metadata sync step
(Baileys `groupFetchAllParticipating` → `chats` table in `store/messages.db`; auto-skips if WA
auth absent; `--list` flag). Copy as-is; depends on `@whiskeysockets/baileys` + `pino`. Uses
`better-sqlite3` (no sqlite3 CLI). Replaces legacy `05-sync-groups.sh` / `05b-list-groups.sh`.
