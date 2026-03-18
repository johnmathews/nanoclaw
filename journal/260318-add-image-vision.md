---
date: 2026-03-18
tags: [feature]
---

# Image Vision Added — Mar 18

## Summary

Added image vision for WhatsApp. Photos sent to the agent are downloaded, resized with sharp, saved to the group
workspace, and passed to Claude as base64-encoded multimodal content blocks.

## What was done

Merged the `skill/image-vision` branch from the `whatsapp` remote. This added:

- `src/image.ts` — Image download, resize via sharp, base64 encoding
- `src/image.test.ts` — 8 unit tests
- Image attachment handling in `src/channels/whatsapp.ts`
- Image passing to agent in `src/index.ts` and `src/container-runner.ts`
- Image content block support in `container/agent-runner/src/index.ts`
- `sharp` npm dependency

## How it works

1. WhatsApp channel detects incoming image messages (`isImageMessage`)
2. Image is downloaded from WhatsApp via baileys
3. Image is resized with sharp and saved to `groups/{folder}/attachments/`
4. Content is set to `[Image: attachments/{filename}]` with caption if present
5. Agent-runner loads the image as a base64-encoded multimodal content block
6. Claude sees and understands the image alongside the text conversation

## Merge notes

Resolved conflicts to preserve both voice transcription and image handling — the upstream skill branch didn't have voice
transcription, so both features needed to coexist in the WhatsApp message handler.
