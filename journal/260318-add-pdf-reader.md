---
date: 2026-03-18
tags: [feature]
---

# PDF Reader Added — Mar 18

## Summary

Added PDF reading capability to all container agents. PDFs sent via WhatsApp are auto-downloaded and the agent can
extract text using `pdf-reader extract <path>`.

## What was done

Merged the `skill/pdf-reader` branch from the `whatsapp` remote. This added:

- `container/skills/pdf-reader/SKILL.md` — Agent-facing documentation
- `container/skills/pdf-reader/pdf-reader` — CLI script using poppler-utils (pdftotext/pdfinfo)
- `poppler-utils` in container Dockerfile
- PDF attachment download in `src/channels/whatsapp.ts`
- PDF tests in `src/channels/whatsapp.test.ts` (3 new tests, 48 total)

## How it works

1. WhatsApp channel detects `documentMessage` with `mimetype: application/pdf`
2. PDF is downloaded and saved to `groups/{folder}/attachments/{filename}`
3. Message content becomes `[PDF: attachments/{filename} ({size}KB)]` with extraction hint
4. Agent uses `pdf-reader extract attachments/{filename}` to read the text
5. Agent can also fetch PDFs from URLs via `pdf-reader fetch <url>`

## Merge notes

Resolved conflicts to preserve image handling, voice transcription, and PDF handling — all three now coexist in the
WhatsApp message handler.
