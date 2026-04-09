# Skip image multimodal for MCP-powered groups

## What happened

Investigated why the slack_journal agent was wasting tokens on image processing. The journal MCP server
at 192.168.2.105:8400 handles all OCR internally — Claude never needs to see the raw images. But the
agent was:

1. Receiving images as multimodal content blocks via the hardcoded host pipeline (~1-2k tokens each)
2. Calling `Read` on image files inside the container, sending them to Claude *again* as vision input
3. Describing the image in text before calling the MCP ingestion tool

All three are unnecessary when an MCP server does OCR.

## Changes

### Agent instructions (`groups/slack_journal/CLAUDE.md`)
- Documented `journal_ingest_from_url` tool (was undocumented but functional)
- Added explicit "never Read image files" instruction
- Instructed agent to extract Slack image URLs and pass directly to MCP

### Per-group `skipImageMultimodal` config
- Added `skipImageMultimodal?: boolean` to `GroupConfig` in `src/group-config.ts`
- Added `cleanupImageFiles()` to `src/image.ts` — deletes files from disk without reading into memory
  (needed because `loadImageData()` normally handles cleanup as a side effect of reading)
- Wired into `src/index.ts`: when flag is set, images are cleaned up but not loaded as base64
- Enabled for slack_journal via `config.json`

### Slack image URL passthrough (`src/channels/slack.ts`)
- Pre-existing change: appends `[Slack image URL: ...]` to message content so the agent can pass it
  to `journal_ingest_from_url` without needing to read the file

## Why this matters

The journal group processes handwritten pages regularly. Each image was being sent to Claude twice
(once via multimodal pipeline, once via agent `Read`), plus Claude was spending output tokens describing
the image before ingesting it. The MCP server does all this work already — Claude just needs to forward
the URL and report the OCR result.

## Design decisions

- Made it a per-group config flag rather than a global setting because most groups *do* need Claude
  to see images (e.g., WhatsApp groups without an MCP server)
- Added `cleanupImageFiles()` as a separate function rather than modifying `loadImageData()` because
  the two have fundamentally different purposes (load+cleanup vs cleanup-only)
- `readGroupConfig()` is now called in both `index.ts` (for image skipping) and `container-runner.ts`
  (for model selection) — acceptable since it's a synchronous read of a tiny JSON file
