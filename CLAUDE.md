# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills
that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has
isolated filesystem and memory.

## Key Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/index.ts`                      | Orchestrator: state, message loop, agent invocation        |
| `src/channels/registry.ts`          | Channel registry (self-registration at startup)            |
| `src/ipc.ts`                        | IPC watcher and task processing                            |
| `src/router.ts`                     | Message formatting and outbound routing                    |
| `src/config.ts`                     | Trigger pattern, paths, intervals                          |
| `src/container-runner.ts`           | Spawns agent containers with mounts, parses progress       |
| `src/task-scheduler.ts`             | Runs scheduled tasks                                       |
| `src/image.ts`                      | Image processing, base64 loading, reference parsing        |
| `src/transcription.ts`              | Voice message transcription via OpenAI Whisper             |
| `src/db.ts`                         | SQLite operations                                          |
| `store/messages.db`                 | SQLite database (messages, chats, tasks, sessions, state)  |
| `groups/{name}/CLAUDE.md`           | Per-group memory (isolated)                                |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill               | When to Use                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `/setup`            | First-time installation, authentication, service configuration    |
| `/customize`        | Adding channels, integrations, changing behavior                  |
| `/debug`            | Container issues, logs, troubleshooting                           |
| `/update-nanoclaw`  | Bring upstream NanoClaw updates into a customized install         |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch     |
| `/get-qodo-rules`   | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## WhatsApp Dedicated Number

The agent runs on its own WhatsApp Business account (`ASSISTANT_HAS_OWN_NUMBER=true`). This means:

- The agent has a separate phone number (eSIM) linked via WhatsApp Business
- No message prefix needed — `fromMe` flag distinguishes bot messages from user messages
- Chat looks like a normal 1-on-1 conversation
- Auth uses pairing code (`npm run auth --pairing-code --phone <number>`) — more reliable than QR in terminals

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run
`/add-whatsapp` (or
`git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`)
to install it. Existing auth credentials and groups are preserved.

## Slack Working Indicator

Slack channels show an :eyes: reaction on the triggering message while the agent works. The reaction is added via
`setTyping(true, messageTs)` and removed when the first response is sent or `setTyping(false)` is called. Reactions
don't trigger unread notifications — unlike posting a placeholder message, which does. The bot needs the
`reactions:write` scope. The `setTyping` interface accepts an optional `messageTs` parameter (the Slack message
timestamp to react to).

## Image Attachment Pipeline

Images are loaded into base64 on the **host** side before container spawn, not read from files inside the container.
This eliminates race conditions between attachment cleanup and container file reads. The flow:

1. Channel downloads image → `processImage()` resizes and saves to `groups/{folder}/attachments/`
2. `loadImageData()` reads each file into memory and **deletes it immediately**
3. Base64 data goes to the container via `ContainerInput.imageAttachments` (JSON over stdin)
4. Agent-runner sends data directly to Claude — no file reads needed

Both WhatsApp (`[Image: attachments/...]`) and Slack (`[Image attached: attachments/...]`) formats are parsed by
`parseImageReferences()`. Media types are inferred from file extension (not hardcoded). WhatsApp downloads retry twice
on failure with linear backoff.

## Agent-Runner Source Mount

Container agents mount `data/sessions/{group}/agent-runner-src` over `/app/src`. The source is synced from
`container/agent-runner/src/` on every container spawn, so changes to the agent-runner code take effect on the next
agent invocation without needing to rebuild the container image (the entrypoint recompiles TypeScript at runtime).

## Merging Skill Branches

Always **rebase skill branches onto current main before merging**, never merge directly. Skill branches fork from an
older main and their versions of shared files (especially `src/db.ts`) may be missing columns, fields, or migrations
added after the fork point. A direct merge can silently drop these changes during conflict resolution. Rebasing surfaces
conflicts in the skill branch where they're easier to review.

After merging any skill branch, run `npm test` and verify all tests pass before committing. The registered group
round-trip tests in `src/db.test.ts` specifically guard against dropped DB columns — if a merge breaks field persistence,
these tests will catch it.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the
builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run
`./container/build.sh`.
