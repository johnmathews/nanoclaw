## Slack formatting — the gotchas that bite

When you're replying in a Slack conversation (your group folder starts with `slack_`, or the inbound `chatJid`/channel id is Slack-namespaced), Slack uses **mrkdwn**, not standard Markdown. The full reference is in this skill's `SKILL.md`; these are the mistakes that actually break messages:

- **Email addresses are plain text — never wrap them.** Write `someone@example.com` as-is and Slack auto-links it. Do NOT hand-encode `<mailto:...>`, do NOT put it inside `<...>`, and do NOT slip a `<` before the `@`. The `<@...>` form is ONLY for a real Slack user ID — an email is not a mention. Getting this wrong renders the broken literal `someone<@example.com>` (the `@example.com` is mis-parsed as a failed user mention).
- **Mentions need a real user ID:** `<@U1234567890>`, not `<@name>` and not an email. If you don't have the ID, use the person's name in plain prose.
- **Bold is single asterisks** (`*bold*`), not `**bold**`. Links are `<url|text>`, not `[text](url)`. No `#` headings, no numbered-list markers, no `---` rules.
- **Don't restate someone's email/phone back to them in a channel** just to confirm you sent something — it's redundant and leaks their contact details. A short "sent ✅" is enough.
