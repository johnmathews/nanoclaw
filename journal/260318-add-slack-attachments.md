---
date: 2026-03-18
tags: [feature]
---

# Slack Attachment Processing — Mar 18

## Summary

Enabled Slack channels to process file attachments: images (vision), audio/voice (transcription), and documents (Excel,
etc.). Previously all file messages were silently dropped.

See [docs/SLACK-ATTACHMENTS.md](../docs/SLACK-ATTACHMENTS.md) for full details.

---

## What was done

**`src/channels/slack.ts`**:

- Added `SlackFile` interface for type-safe file handling
- Stored `botToken` as instance field (needed for authenticated file downloads)
- Expanded subtype filter to allow `file_share` messages (was rejecting them)
- Relaxed text guard to allow file-only messages (was dropping them)
- Added `downloadSlackFile()` — authenticated GET against Slack's `url_private_download`
- Added `processSlackFiles()` — orchestrates per-file handling by mimetype

**`src/transcription.ts`**:

- Exported new `transcribeAudioBuffer(buffer)` — channel-agnostic Whisper wrapper
- WhatsApp's `transcribeAudioMessage` continues to work unchanged

**`src/container-runner.ts`**:

- Added attachment directory cleanup before each container spawn

## Why

The Slack channel was silently dropping all file attachments due to two filters:

1. The subtype filter rejected `file_share` messages (only allowed `bot_message`)
2. The text guard rejected messages with no text body (file-only messages)

## Design decisions

- **Files saved to group folder** (`groups/{folder}/attachments/`) — already mounted in the container, no new mount
  needed
- **Audio transcription done host-side** — consistent with WhatsApp voice pattern; Slack's own transcript used when
  available (faster, free), Whisper as fallback
- **No changes to types.ts** — file references embedded in `content` string for backward compatibility
- **No changes to agent-runner** — agent already has Read (vision) and Bash tools
- **Attachment cleanup per run** — safe because GroupQueue serializes container runs per group

## Prerequisites

Slack bot needs `files:read` OAuth scope added at api.slack.com.
