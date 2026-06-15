# Section 03 — Multimodal & Reactions

Host-side preprocessing (PDF/voice) + container-side rendering (image blocks, voice/PDF
prose) + the reactions MCP tool. The chat-sdk-bridge / WhatsApp consumers of the host
modules are in §02.

> Recover bodies with `git show 971239a:<path>`.

---

## 3.1 Host — PDF text extraction + voice transcription

**Origin:** fork-original. **Commit:** `0888c7f feat(multimodal,reactions): port v1's image/voice/PDF + chat.onReaction`.
**Files:** `src/pdf-extract.ts` (new), `src/transcription.ts` (new) (+ their `*.test.ts`).

Apply: copy both files verbatim.
- `pdf-extract.ts` exports `extractPdfText(pdf, opts?)` (pipes stdin→stdout through `pdftotext`,
  layout-preserving; caps 250KB output / 50MB input), `isPdfMime(mime)`, `PdfExtractionError`.
  Requires `pdftotext` (poppler-utils) on the host / in the container image.
- `transcription.ts` exports `transcribeAudio(audio, filename, mime, opts?)`,
  `isTranscribableMime(mime)`, `TranscriptionError`, `resetTranscriptionCacheForTests()`. Uses
  OpenAI Whisper with `OPENAI_API_KEY` from host `.env` via `readEnvFile` (from `./env.js`).

These are consumed by `chat-sdk-bridge.ts` (`maybeTranscribe`/`maybePdfExtract`) and
`whatsapp.ts` — see §02. Results attach as `transcription`/`extractedText` (or
`transcriptionError`/`pdfExtractionError`) on the inbound attachment object.

---

## 3.2 Container — multimodal image content blocks

**Origin:** fork-original. **Commits:** `0888c7f`, `c87dabb` (make provider hooks optional),
`092cf12` (merge). **Files:** `container/agent-runner/src/multimodal.ts` (new) + `multimodal.test.ts`
(new), `providers/types.ts`, `providers/claude.ts`, `poll-loop.ts`, `formatter.ts` + `formatter.test.ts`.

Apply:
1. Create `multimodal.ts`. Exports `extractImageBlocks(messages: MessageInRow[]): ContentBlock[]`
   and `setWorkspaceRootForTests(root)`. Reads image attachments from `messages_in` rows (kinds
   `chat`, `chat-sdk`), resolves `localPath` under `/workspace/` (path-traversal guard), enforces
   size ≤ `MAX_IMAGE_BYTES = 4MB`, returns `ImageContentBlock[]`. Skips non-image/unsupported
   mime (only jpeg/png/gif/webp), `skipMultimodal:true`, missing/oversized files (those still
   appear via `localPath` text so the agent can `Read` them).
2. In `providers/types.ts` add:
   ```ts
   export type ImageMediaType = 'image/jpeg'|'image/png'|'image/gif'|'image/webp';
   export interface ImageContentBlock { type:'image'; source:{ type:'base64'; media_type:ImageMediaType; data:string } }
   export interface TextContentBlock { type:'text'; text:string }
   export type ContentBlock = ImageContentBlock | TextContentBlock;
   ```
   Add `readonly supportsMultimodalContent?: boolean;` to `AgentProvider` and
   `pushBlocks?(blocks: ContentBlock[]): void;` to `AgentQuery`.
3. In `providers/claude.ts`: import `ContentBlock`; widen `SDKUserMessage.message.content` to
   `string | ContentBlock[]`; add `MessageStream.pushBlocks(blocks)` (enqueues a user turn with
   blocks array); add `readonly supportsMultimodalContent = true;` to `ClaudeProvider`; in
   `query()` return, add `pushBlocks: (blocks) => stream.pushBlocks(blocks)`.
4. In `poll-loop.ts`: import `extractImageBlocks`; after building the initial query, if
   `config.provider.supportsMultimodalContent` push `extractImageBlocks(keep)` via
   `query.pushBlocks?.()`; thread `supportsMultimodalContent ?? false` into `processQuery()` and
   do the same for follow-up batches.
5. In `formatter.ts` `formatAttachments`, prepend cases before the `localPath` fallback: voice
   (`a.transcription` → `[voice: <name> — saved to <path>]\nTranscription: <text>`;
   `a.transcriptionError` → failure variant); PDF (`a.extractedText` → `[pdf: <name> — saved to
   <path>]\n<pdf_text><![CDATA[<body>]]></pdf_text>`, escaping `]]>`→`]]&gt;`;
   `a.pdfExtractionError` → failure variant).
6. Recreate `multimodal.test.ts` and the `describe('attachments rendering')` block in
   `formatter.test.ts`.

Note: the host chat-sdk-bridge / WA adapter must populate `localPath`, `transcription`,
`transcriptionError`, `extractedText`, `pdfExtractionError` on attachments (§02/§3.1).

---

## 3.3 Container — `query_reactions` MCP tool

**Origin:** fork-original. **Commits:** `bc35a81` (own module), `b74d3ef` (port reactions).
**Files:** `container/agent-runner/src/mcp-tools/reactions.ts` (new), `mcp-tools/index.ts` (barrel),
`mcp-tools/core.test.ts` (fork-original coverage).

Apply: create `mcp-tools/reactions.ts` — tool `query_reactions`, schema `{ target_message_id?:
string, limit?: integer }` (no required fields). Handler reads `messages_in WHERE kind='chat-sdk'
AND content LIKE '%"reaction":%' ORDER BY timestamp DESC LIMIT (limit*4)`, parses each content
JSON, extracts `reaction.{emoji, rawEmoji, added, targetMessageId, userId}` + top-level `sender`,
filters by `targetMessageId` if passed, truncates to `limit`, returns JSON array. Imports
`getInboundDb` from `../db/connection.js` (reuses module connection — correct for a DB the
container owns reading) and `registerTools` from `./server.js`. `registerTools([queryReactions])`.
Add `import './reactions.js';` to `mcp-tools/index.ts` (before `./scheduling.js`).

Reactions arrive as synthetic `messages_in` rows from the host `buildReactionInbound` (§2.1) —
without it this tool just returns empty (no error).

---

## 3.4 `reactions` container skill

**Origin:** fork-original. **Commit:** `1b21950`. **File:** `container/skills/reactions/SKILL.md`.
Apply: copy `container/skills/reactions/` as-is. Documents `react_to_message` + `query_reactions`
usage and using reactions as silent acknowledgment. Depends on the host MCP server exposing those
tools (harmless if absent).
