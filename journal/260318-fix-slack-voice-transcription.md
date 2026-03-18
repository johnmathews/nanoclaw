# Fix Slack Voice Transcription

**Date:** 2026-03-18
**Type:** Bug fix

## Problem

Slack voice notes (audio clips) failed transcription with `400 Invalid file format` from OpenAI Whisper. WhatsApp voice
notes worked fine. The error was logged but the user only saw "transcription unavailable" with no explanation.

## Root Cause

`transcribeWithOpenAI()` hardcoded the filename as `voice.ogg` with mime type `audio/ogg`. Slack audio clips are `.m4a`
files (`audio/mp4`). OpenAI validates the file extension against the actual content and rejects mismatches.

## Fix

1. **Parameterized file format**: `transcribeAudioBuffer()` and `transcribeWithOpenAI()` now accept optional `filename`
   and `mimetype` parameters, defaulting to `voice.ogg`/`audio/ogg` for backward compatibility (WhatsApp).

2. **Slack passes actual metadata**: `processSlackFiles()` now passes `file.name` and `mime` from the Slack file object.

3. **Error surfacing**: `transcribeWithOpenAI()` now throws on errors (instead of returning null), so callers can report
   the specific failure. Slack shows `[Voice note: transcription failed — <reason>]`. WhatsApp catches the error and
   returns the fallback message (existing behavior preserved).

4. **API error reporting**: When the container agent fails with API errors (Anthropic 529 overloaded, rate limits, etc.),
   the error is now reported back to the user in the channel with a message that retry is automatic.

## Regression Tests Added

- m4a audio passes correct filename/mimetype (the exact failure case)
- webm audio passes correct filename/mimetype (another common format)
- Transcription errors show error message to user (not silently swallowed)

## Lesson

Never hardcode values that vary by caller context. The function served multiple channels with different audio formats
but assumed a single format.
