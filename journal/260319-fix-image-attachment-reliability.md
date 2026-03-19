---
date: 2026-03-19
tags: [bugfix, reliability]
---

# Image Attachment Reliability Fix — Mar 19

## Problem

Sending an image in WhatsApp sometimes resulted in the agent not receiving it. The bot would reply "I can't locate
the image file on disk." On investigation, the first of two identical images was lost; the second worked.

## Root cause

A race condition in the image handoff pipeline. The original design was file-based:

1. WhatsApp channel downloads image, saves to `groups/{folder}/attachments/img-xxx.jpg`
2. Message stored in DB with text reference `[Image: attachments/img-xxx.jpg]`
3. Container runner cleans up ALL files in `attachments/` before spawning the container
4. Agent-runner inside the container reads the file from the mounted volume

Step 3 deletes files that step 4 needs. The cleanup ran before the container could read the images. This also affected
back-to-back messages: the first container run could delete a second message's image before it was ever processed.

## Fix: eliminate the file-based handoff

Images are now loaded into base64 on the host side (in `loadImageData()`) before any container spawn. The container
receives image data directly via JSON stdin. No file mounts, no cleanup races, no timing dependencies.

The lifecycle is now:

1. WhatsApp channel downloads image, saves to disk (unchanged)
2. `loadImageData()` reads each file into memory, **deletes it immediately after**
3. Base64 data passed to container via `ContainerInput.imageAttachments`
4. Agent-runner uses data directly — no `readFileSync` from mounted volume

## Additional fixes in this session

- **Slack images now work as multimodal content.** The image reference regex only matched WhatsApp's `[Image: ...]`
  format, not Slack's `[Image attached: ...]`. Unified the pattern.
- **Media type inference.** Was hardcoded to `image/jpeg`. Now inferred from file extension (PNG, GIF, WebP supported).
- **WhatsApp download retry.** Added 2 retries with linear backoff for transient network failures.
- **Silent failure removed.** Agent-runner used to silently drop missing images. Now impossible because data is
  pre-loaded, but the agent also gets a system message if any images fail to load on the host side.

## Tests added

15 new tests covering `loadImageData`, Slack format parsing, media type inference, retry behavior, and base64
passthrough to the container.
