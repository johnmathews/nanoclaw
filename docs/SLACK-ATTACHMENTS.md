# Slack Attachment Processing

Slack channels process file attachments — images, audio/voice notes, and documents — so the agent can see and work with
them.

## How It Works

When a Slack message includes file attachments:

1. **Audio** (`audio/*`): Always transcribed via OpenAI Whisper for consistent, reliable results. The audio is downloaded
   from Slack and sent to the Whisper API. The transcript is embedded in the message as `[Voice note: <transcript>]`.

2. **Images** (`image/*`): Downloaded to `groups/{folder}/attachments/img-{timestamp}-{fileId}.{ext}`. The agent sees
   `[Image attached: attachments/filename]` in the message and can use Claude Code's `Read` tool for vision.

3. **Other files** (Excel, CSV, PDF, etc.): Downloaded to `groups/{folder}/attachments/{fileId}-{name}`. The agent sees
   `[File attached: attachments/filename] (type, size)` and can process them via Bash tools.

## File Lifecycle

Attachments are saved to `groups/{folder}/attachments/` which is already mounted in the container at
`/workspace/group/attachments/`. The directory is **cleaned up at the start of each container invocation** — stale files
from previous runs are deleted before the new agent spawns. This is safe because GroupQueue serializes container runs per
group.

## Slack App Requirements

The bot needs the **`files:read`** OAuth scope to download file content. Add it at
[api.slack.com/apps](https://api.slack.com/apps) under **OAuth & Permissions → Bot Token Scopes**, then reinstall the
app to the workspace.

The existing `channels:history` scope handles receiving the `file_share` events.

## Message Format

File references are embedded directly in the `content` string, keeping backward compatibility with all channels:

```
User's text message
[Image attached: attachments/img-1710756000000-F12345.png]
[File attached: attachments/F67890-report.xlsx] (Excel Spreadsheet, 24.5 KB)
[Voice note: Hey, can you check the latest deployment?]
```

## Relevant Files

| File                    | Change                                              |
| ----------------------- | --------------------------------------------------- |
| `src/channels/slack.ts` | File download, processing, and content embedding    |
| `src/transcription.ts`  | New `transcribeAudioBuffer()` export for any channel |
| `src/container-runner.ts`| Attachment directory cleanup before container spawn  |
