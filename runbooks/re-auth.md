# Re-Authentication Playbook

Symptom-keyed procedures for re-authenticating each channel and MCP credential. Tokens drift over time, OAuth refresh
tokens get revoked, and WhatsApp sessions occasionally need re-pairing. Each section below is independent — re-auth
for one channel does not affect the others.

## When to consult this runbook

- A channel stops sending/receiving but the rest of the service is healthy.
- A `/health` check shows `connected: false` for a specific channel.
- An MCP server reports "Authentication token is invalid or expired" or "OAuth token expired or revoked".
- Logs show repeated `401 Unauthorized` or `invalid_auth` from a single integration.

Always confirm the symptom is limited to one credential before re-auth-ing. If multiple channels are failing,
likely a service or network issue — see [troubleshooting.md](troubleshooting.md) first.

---

## WhatsApp

**Symptom:** Baileys logs show disconnect reason `401 loggedOut`. The WhatsApp channel stops; Slack/Gmail/Telegram
continue running (`src/channels/whatsapp.ts` isolates single-channel logouts since 2026-04-19).

### Procedure

Stop nanoclaw first so it doesn't race the auth script for socket state:

```bash
systemctl --user stop nanoclaw
cd /srv/apps/nanoclaw
rm -rf store/auth/* store/auth-status.txt store/qr-data.txt
npm run auth -- --pairing-code --phone <your-number>
```

An 8-character pairing code prints. On the phone:
**WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"** → enter the code.
You have ~60 seconds before the server rotates the code.

Wait for `✓ Successfully authenticated with WhatsApp!` then:

```bash
systemctl --user start nanoclaw
curl -s http://127.0.0.1:3002/health | jq '.channels'
```

All connected channels should now show `connected: true`.

### Gotchas

- **Clear `store/auth-status.txt` too.** Partial state from a failed run (`failed:405`, `failed:logged_out`) can
  mislead the next attempt's diagnostics.
- **`state.creds.registered` short-circuits the script** with "Already authenticated" even when the creds are
  server-side invalid. `rm -rf store/auth/*` before re-pairing is mandatory, not optional.
- **Crash-loop → rate-limit link.** If nanoclaw was crash-looping with 401s before the fix landed, WhatsApp's
  anti-abuse system soft-bans the number and returns `status 405` on new pairing attempts. Cool-down is hours,
  not minutes. If the first re-auth attempt 405s, **stop trying** and wait — additional attempts extend the ban.
- **Pairing code beats QR on a headless server.** QR only works if you can reliably render the terminal QR over SSH;
  pairing code is plain text.
- **Stale auth backup dirs.** Each cleanup leaves a timestamped backup at `store/auth-stale-YYYYMMDD-HHMMSS/`. Safe
  to delete once the new session is confirmed working.

### Baileys version

WhatsApp changes its web protocol periodically; if re-pairing keeps 405-ing even after a cool-down, check
`package.json` for the pinned `@whiskeysockets/baileys` version and consider bumping before assuming the number
is banned.

---

## Gmail

**Symptom:** Startup log line `Gmail OAuth token expired or revoked. Skipping Gmail channel.` The Gmail channel
stops; other channels continue.

### Procedure

The Gmail MCP server uses OAuth credentials shared with Google Calendar. Re-auth uses
`@gongrzhe/server-gmail-autoauth-mcp` which opens a browser flow.

```bash
rm ~/.gmail-mcp/credentials.json
GOOGLE_OAUTH_CREDENTIALS=~/.gmail-mcp/gcp-oauth.keys.json \
CREDENTIALS_PATH=~/.gmail-mcp/credentials.json \
  npx -y @gongrzhe/server-gmail-autoauth-mcp
```

This prints a URL; open it in a browser, complete the consent screen, and the new credentials are written back to
`~/.gmail-mcp/credentials.json`. Then restart nanoclaw so the Gmail channel reconnects:

```bash
systemctl --user restart nanoclaw
```

### Gotchas

- **Headless server.** If the server has no display and no SSH tunnel, the OAuth callback can't return to it.
  Run the command from a terminal session that survives a few minutes (Claude Code's bash timeout will kill it),
  or use an SSH session with port-forwarding mirroring the Google Calendar procedure below.
- **OAuth keys are shared.** `~/.gmail-mcp/gcp-oauth.keys.json` is the client-app credentials file used by both
  Gmail and Google Calendar MCP servers. Don't replace it during Gmail re-auth — only the per-user `credentials.json`
  needs to be regenerated.
- **Refresh-token revocation.** If the refresh token has been explicitly revoked (e.g. via myaccount.google.com →
  Security → Third-party access), the re-auth flow above is the only fix. There's no automatic recovery.

---

## Google Calendar

**Symptom:** Google Calendar MCP starts and says "Valid tokens found" but API calls fail with
"Authentication token is invalid or expired."

### Procedure

On a headless server the OAuth callback redirects to `localhost:3501`, which has to reach the server's auth process.
The cleanest way is an SSH tunnel.

From your **local machine** (not the server):

```bash
ssh -L 3501:localhost:3501 john@<server>
```

Then on the **server** (inside that SSH session):

```bash
GOOGLE_OAUTH_CREDENTIALS=/home/john/.gmail-mcp/gcp-oauth.keys.json \
  npx -y @cocal/google-calendar-mcp auth
```

Open the URL it prints in your **local** browser. The OAuth callback hits `localhost:3501` on your local machine,
the tunnel forwards it to the server's auth process, and tokens are written to
`~/.config/google-calendar-mcp/tokens.json`.

Then restart nanoclaw:

```bash
systemctl --user restart nanoclaw
```

### Gotchas

- **Bash-tool timeout.** Don't run this through Claude Code's bash tool — the default 2-minute timeout will kill the
  auth process before you've finished the browser flow. Use a real terminal.
- **Auth server times out fast.** Complete the browser flow within ~60 seconds of clicking the URL.
- **Tunnel direction matters.** `ssh -L` forwards a **local** port to the server. If you `ssh -R` (remote forward)
  the callback won't resolve correctly.

### Token paths

| File                                          | Purpose                                |
| --------------------------------------------- | -------------------------------------- |
| `~/.gmail-mcp/gcp-oauth.keys.json`            | OAuth client app credentials (shared with Gmail) |
| `~/.config/google-calendar-mcp/tokens.json`   | Per-user access + refresh tokens       |

---

## Slack

**Symptom:** Logs show `invalid_auth` or `not_authed` errors from `@slack/web-api`, or the Slack channel reports
`connected: false` despite no recent token rotation. Slack bot tokens (`xoxb-`), app-level tokens (`xapp-`), and
signing secrets don't auto-expire, so re-auth is needed only when:

- The bot has been removed from the workspace (or its OAuth app re-installed).
- A new OAuth scope was added and the existing tokens need re-issuing.
- A token was manually rotated in the Slack admin panel.

### Procedure

The `/add-slack` skill (run inside `claude`) is the same code path that bootstraps Slack credentials initially —
re-running it walks you through getting fresh tokens and writing them to `.env`.

```bash
cd /srv/apps/nanoclaw
claude
# inside claude:
/add-slack
```

The skill will prompt for:
- **Bot token** (`xoxb-...`) — from your Slack app's "OAuth & Permissions" page
- **Signing secret** — from the app's "Basic Information" page
- **App-level token** (`xapp-...`) with `connections:write` scope — from "Basic Information → App-Level Tokens"

After the skill updates `.env`, restart nanoclaw:

```bash
systemctl --user restart nanoclaw
curl -s http://127.0.0.1:3002/health | jq '.channels[] | select(.name=="slack")'
```

### Gotchas

- **Socket Mode means no public URL needed.** The app-level token (`xapp-`) keeps a WebSocket open to Slack; you
  don't need to host a webhook endpoint or run a reverse proxy.
- **Scope changes need user re-install.** If you add an OAuth scope (e.g. `reactions:write`), Slack invalidates the
  existing bot token and you have to re-install the app to your workspace before generating a new `xoxb-` token.
- **Don't confuse token owner with bot identity.** `xoxb-` tokens are scoped to the bot user; messages posted with
  them appear as the bot, not the operator. This matters for testing.

---

## Verifying re-auth worked

For all channels, after a restart:

```bash
curl -s http://127.0.0.1:3002/health | jq '.channels'
```

The relevant channel should show `connected: true` and `lastMessageAt` should advance once a test message arrives.
For MCP credentials (Gmail, Calendar), the easiest verification is to ask Claude in the main group to run a quick
tool call:

> @agent list my next 3 calendar events

If the credentials are bad the tool call will surface the same auth error you started with.

## Related

- [Troubleshooting](troubleshooting.md) — symptom-based fixes that don't involve re-auth
- [Channel Operations](channel-operations.md) — adding, removing, reconfiguring channels
- [Health Monitoring](health-monitoring.md) — verifying service health overall
