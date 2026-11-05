---
name: email-sending
description: Build email messages correctly for Gmail API or SMTP. Use whenever sending an email — covers RFC 2047 header encoding so non-ASCII subjects/display names don't arrive as mojibake, CRLF + base64url payload rules, and a pre-send verification step.
---

# Email Sending Rules

Rules for constructing emails (Gmail API or any SMTP path). Written after a real incident where a Subject line containing an emoji and a `·` arrived as double-mojibake.

## The bug to avoid

Subject written as raw UTF-8 bytes:
```
Subject: 📋 Job Report - Tue 26 May 2026 | Product / Creative · NL · 12 matches
```

Recipient saw:
```
Ã°ÂŸ"Â‹ Job Report - Tue 26 May 2026 | Product / Creative Ã,Â· NL Ã,Â· 12 matches
```

Root cause: **RFC 2822 headers must be 7-bit ASCII.** Non-ASCII characters require RFC 2047 "encoded-word" syntax. Without it, mail clients fall back to Latin-1, producing the double mojibake (UTF-8 bytes read as Latin-1 then re-encoded as UTF-8 for display).

The bug is invisible in a terminal — terminals render UTF-8 fine. It only surfaces in the mail client.

## The rule

**Any header value containing non-ASCII characters MUST be wrapped in RFC 2047 encoded-word form:**

```
=?UTF-8?B?<base64-of-utf8-bytes>?=
```

Applies to: `Subject`, `From` display name, `To` display name, `Cc` display name, `Reply-To` display name, attachment `filename` parameters — anywhere a header carries human-readable text.

Address portions themselves (`<x@y.com>`) stay ASCII; only the display-name part gets encoded.

## How to build a Gmail API payload in Node

Use this pattern for every email. Do not write raw UTF-8 into headers.

```javascript
const subject = "📋 Job Report — Wednesday 27 May 2026 | …";
const subjectAscii = /^[\x00-\x7F]*$/.test(subject);
const subjectHeader = subjectAscii
  ? subject
  : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;

const body = htmlContent; // UTF-8 string is fine in BODY
const raw =
  `To: recipient@example.com\r\n` +
  `Subject: ${subjectHeader}\r\n` +
  `MIME-Version: 1.0\r\n` +
  `Content-Type: text/html; charset=UTF-8\r\n` +
  `Content-Transfer-Encoding: 8bit\r\n` +
  `\r\n` +
  body;

const rawB64 = Buffer.from(raw, "utf8")
  .toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// POST { raw: rawB64 } to https://gmail.googleapis.com/gmail/v1/users/me/messages/send
```

Key points:
1. **Headers**: encode if any byte > 0x7F.
2. **Body**: UTF-8 is fine, but declare `Content-Type: text/html; charset=UTF-8` and `Content-Transfer-Encoding: 8bit` (or quoted-printable / base64).
3. **CRLF line endings** in the raw message (`\r\n`, not `\n`).
4. **base64url** the whole raw message for the Gmail API `raw` field (`-` and `_`, no `=` padding).

## Verification before sending

Always run this sanity check on the assembled raw message:
```bash
node -e 'const r = process.argv[1]; const headers = r.split("\r\n\r\n")[0]; for (const line of headers.split("\r\n")) { for (let i = 0; i < line.length; i++) { if (line.charCodeAt(i) > 127) { console.error("NON-ASCII IN HEADER:", line); process.exit(1); } } } console.log("OK");' "$RAW_MESSAGE"
```

If it fails, fix the offending header — do not send.

## What NOT to do

- Don't put emojis or accented characters directly into a `Subject:` line.
- Don't rely on `Content-Type: charset=UTF-8` to "save" the headers — that header only governs the body.
- Don't use `python3` for this without verifying it's installed; prefer `node` (always available in agent containers).
- Don't skip the verification step "just this once" — the bug is invisible in your own terminal because terminals render UTF-8 fine; you only see it when the mail client renders it.
