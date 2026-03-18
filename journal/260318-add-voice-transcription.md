---
date: 2026-03-18
tags: [feature]
---

# Voice Transcription Added — Mar 18

## Summary

Added automatic voice message transcription for WhatsApp using OpenAI's Whisper API. Voice notes are now transcribed and delivered to the agent as `[Voice: <transcript>]`.

---

## What was done

Merged the `skill/voice-transcription` branch from the `whatsapp` remote. This added:

- `src/transcription.ts` — Voice transcription module using OpenAI Whisper API
- Voice handling in `src/channels/whatsapp.ts` — `isVoiceMessage` check, `transcribeAudioMessage` call
- Transcription tests in `src/channels/whatsapp.test.ts` (41 tests passing)
- `openai` npm dependency

## How it works

1. WhatsApp channel detects incoming voice messages
2. Audio is downloaded from WhatsApp
3. Audio is sent to OpenAI's Whisper API for transcription
4. Transcript is delivered to the agent as `[Voice: <transcript>]`
5. Agent responds to the voice content as if it were a text message

## Configuration

- Requires `OPENAI_API_KEY` in `.env` (and synced to `data/env/env` for container access)
- Cost: ~$0.006/minute of audio (~$0.003 per typical 30-second voice note)

## Merge notes

Two conflicts during merge:

- `.env.example` — resolved by keeping both sides (Slack/Telegram tokens + OpenAI key)
- `package-lock.json` — resolved with `--theirs` + `npm install`
