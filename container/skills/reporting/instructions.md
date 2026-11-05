# Structured Reports — Shared Style

Use this skill when you are producing a **structured report**: a scheduled
recap, a periodic digest, a multi-section summary, anything bigger than a
short chat reply. For routine acks and one-paragraph answers, ignore this
file.

If your channel's `CLAUDE.local.md` contradicts a rule here, **the channel
wins**. This file is the default, not the law.

## Voice and audience

- John reads fast. Signal over throat-clearing. No preamble, no recap of
  what you're about to say.
- One fact per bullet. Short paragraphs only when bullets won't carry the
  idea.
- Concrete > generic. Numbers, names, dates. Never "various", "several".
- If you don't know something, say so. Don't fill gaps with plausible
  guesses dressed up as fact.

## Report shape — summary first, detail second

Every structured report has two zones, in this order:

1. **Summary / advice / market pulse** — what John needs to act on, or the
   one-screen "so what". Goes at the top, immediately after the header.
   Bullets only. Each bullet is its own sentence.
2. **Detail** — the per-section breakdown. Same section order as the
   summary references. Full content, but still scannable.

The summary block is the centrepiece. If a reader stops reading after the
summary, they should have the actionable information.

## Omit empty sections

If a section has no content, **drop it entirely** — heading and all. Do not
emit filler like "(nothing)", "no activity", "all clear". Empty subsections
get dropped the same way. The only reason to mention emptiness is when an
entire report is empty, in which case post a single short "all clear" line
instead of an empty skeleton.

## Selectivity

- Quality over quantity. Include something only if it's worth John's
  attention.
- If you're padding to hit a count, stop. Three sharp entries beat seven
  mushy ones.
- Trim ruthlessly. If a sentence restates what the bullet already said,
  delete it.

## Lead with deltas, not absolutes

When reporting a numeric value that has a recent prior value, **lead with
the change**, then the absolute, then any trend note.

- ✅ `-0.7W — Down from 71.1W previously — gentle downward drift all week`
- ❌ `71.1W previously, 70.4W now`

Use the word "stable" only when the change is within an explicit threshold
that you state (e.g. `Stable at 73.8W (Δ0.1W)`). Otherwise always show
direction and magnitude.

## Length discipline

- One message per report. Never split a structured report across multiple
  messages on the same channel — it breaks scanability and notification
  ergonomics. (Block Kit posts are still one message.)
- No walls of text. If a section runs more than ~6 bullets, you have either
  the wrong section boundary or too much filler.

## Per-medium formatting

### Slack (default — mrkdwn)

- `*single asterisks*` for bold. **Never** `**double asterisks**` — Slack
  renders those as literal `**text**`.
- `_underscores_` for italic.
- `•` for bullet markers (or `-` — both render as bullets in mrkdwn).
- One bold heading per section, emoji-prefixed, on its own line.
- **Double blank lines** between sections — Slack collapses single blank
  lines and your sections will run together.
- No raw URL clutter in the body. If a reference needs a link, put it on
  its own line at the end of the section, or use a numbered reference
  scheme that the channel defines.

### Slack (Block Kit — when the channel requires it)

When a channel's `CLAUDE.local.md` mandates Block Kit `rich_text` (e.g. for
guaranteed bold rendering or for interactive elements like checkboxes), use
the channel's specified action IDs and block ordering. The shared rules
above still apply — summary first, omit empty, lead with deltas — they're
just expressed through Block Kit primitives instead of mrkdwn.

Always provide a `fallbackText` plain-text summary on any Block Kit post,
for notifications and accessibility.

### HTML email

- Clean layout: real `<h2>`/`<h3>` headings, `<ul>`/`<li>` bullets,
  `<strong>` for bold.
- Full clickable hyperlinks are fine here — email clients handle them
  gracefully and there's no unfurl noise.
- Don't pack everything into one giant blob. Keep the same section
  structure as the Slack version.

### Plaintext fallback

When neither Slack styling nor HTML applies, write the report as plain
prose with `*` bullets and ALL-CAPS section headers. Same shape, same
selectivity rules.

## Source attribution

When a claim is grounded in a specific source (an upstream commit, an
issue, a newsletter, a calendar event), cite it inline:

- `cherry-pick \`c727bb6\` — fix loads per-group CLAUDE.local.md`
- `From #97 (2025-04-15) — "<quote>"`

Don't cite for general framing — only when the reader might want to verify
or follow up.

## Closing

End with one concrete thing: a follow-up offer, a question, or a "next
step". Never trail off mid-thought. If there's genuinely nothing to follow
up on, end the last section cleanly and stop.

---

<!-- Provenance — rules in this fragment came from:
  - groups/main/tasks/morning-report.md (summary-first/detail, omit-empty,
    Slack mrkdwn rules, single-message rule, "stable" threshold,
    lead-with-deltas, voice, HTML-email rules)
  - groups/slack_job-search-john/CLAUDE.local.md (Slack mrkdwn, no-link
    clutter, summary-first "Market Pulse", HTML email rules, selectivity,
    single-message rule)
  - groups/slack_nanoclaw-introspection/CLAUDE.local.md (omit-empty
    sections + subsections, summary-first "Advice", Block Kit fallback
    text, source attribution)
  - groups/slack_the-managers-guide/CLAUDE.local.md (concise voice, signal
    over throat-clearing, source citation format, Block Kit + fallback
    text, end-with-follow-up rule)

  Resolved conflicts:
  - Slack bold rendering. Default is mrkdwn `*single asterisks*`; channels
    that have empirically observed bold not rendering (the-managers-guide
    in its current Slack client) override to Block Kit `rich_text` with
    `style: {bold: true}`. The shared rule names mrkdwn as the default and
    explicitly hands authority to the channel to override.

  Re-audit this list before deleting from any channel's CLAUDE.local.md.
-->
