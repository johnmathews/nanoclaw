# Documentation Accuracy Review

**Date:** 2026-04-01

## What Changed

Reviewed all documentation against the current codebase and fixed stale/inaccurate content.

## Fixes

1. **README.md token badge alt text** — Updated from "34.9k tokens, 17%" to "91.8k tokens, 46%"
   to match the actual badge SVG (which was already updated by CI).

2. **README.md RFS section** — Removed `/clear` from "Request for Skills" since it's already
   implemented. Added `/add-sms` as a still-wanted skill.

3. **docs/REQUIREMENTS.md RFS section** — Marked `/add-telegram`, `/add-slack`, `/add-discord`,
   `/add-whatsapp`, `/add-gmail`, `/convert-to-apple-container`, and `/setup` (Linux) as already
   implemented. Reduced the wanted list to `/add-signal` and `/add-sms`.

4. **docs/REQUIREMENTS.md Vision section** — Updated from "WhatsApp as the primary I/O channel"
   to "Multi-channel messaging via WhatsApp, Telegram, Slack, Discord, and Gmail."

5. **docs/REQUIREMENTS.md Deployment section** — Updated from "Runs on local Mac via launchd"
   to "Runs on macOS via launchd or Linux via systemd."

6. **docs/REQUIREMENTS.md WhatsApp section** — Added pairing code as an authentication option
   alongside QR code, noting it's recommended for dedicated number setups.

## Why

Documentation drift is inevitable as skills get implemented and the platform expands. These
fixes ensure new contributors and future sessions have accurate context about what exists
and what's still needed.
